import requests
import pandas as pd
import json
import time
import re
from bs4 import BeautifulSoup

TOURNAMENT_GROUPS = {
    "Week of Feb 9": {
        "https://www.wtatennis.com/tournaments/doha/player-list": "WTA 1000 DOHA",
        "https://www.wtatennis.com/tournaments/1155/oeiras-125-indoor-1/2026/player-list": "WTA 125 OEIRAS 1",
    },
    "Week of Feb 16": {
        "https://www.wtatennis.com/tournaments/dubai/player-list": "WTA 1000 DUBAI",
        "https://www.wtatennis.com/tournaments/2051/midland-125/2026/player-list": "WTA 125 MIDLAND",
        "https://www.wtatennis.com/tournaments/1156/oeiras-125-indoor-2/2026/player-list": "WTA 125 OEIRAS 2",
        "https://www.wtatennis.com/tournaments/1157/les-sables-d-olonne-125/2026/player-list": "WTA 125 LES SABLES",
    },
    "Week of Feb 23": {
        "https://www.wtatennis.com/tournaments/2085/m-rida/2026/player-list": "WTA 500 MERIDA",
        "https://www.wtatennis.com/tournaments/2082/austin/2026/player-list": "WTA 250 AUSTIN",
        "https://www.wtatennis.com/tournaments/1124/antalya-125-1/2026/player-list": "WTA 125 ANTALYA 1",
    },
    "Week of Mar 2": {
        "https://www.wtatennis.com/tournaments/609/indian-wells/2026/player-list": "WTA 1000 INDIAN WELLS",
        "https://www.wtatennis.com/tournaments/1107/antalya-125-2/2026/player-list": "WTA 125 ANTALYA 2",
    }
}

API_URL = "https://api.wtatennis.com/tennis/players/ranked"
HEADERS = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36"}

LATAM_CODES = [
    "ARG", "BOL", "BRA", "CHI", "COL", "CRC", "CUB", "DOM", "ECU", "ESA", 
    "GUA", "HON", "MEX", "NCA", "PAN", "PAR", "PER", "PUR", "URU", "VEN"
]

def clean_tournament_word(text):
    if not text: return ""
    return re.sub(r'\bTournament\b', '', text, flags=re.IGNORECASE).strip()

def get_rankings_from_api(date_str):
    all_players, page = [], 0
    while True:
        params = {"metric": "SINGLES", "type": "rankSingles", "sort": "asc", "at": date_str, "pageSize": 100, "page": page}
        try:
            r = requests.get(API_URL, params=params, headers=HEADERS, timeout=10)
            items = r.json().get('content', []) if isinstance(r.json(), dict) else r.json()
            if not items: break
            all_players.extend(items)
            page += 1
            time.sleep(0.05)
        except: break
    return pd.DataFrame([{'ranking': p.get('ranking'), 'player': p.get('player', {}).get('fullName'), 'country': p.get('player', {}).get('countryCode')} for p in all_players])

def process_players(names, rankings_df):
    if not names: return pd.DataFrame(columns=['Pos.', 'Player', 'Country', 'Rank'])
    df = pd.DataFrame({'Player': [name.strip().title() for name in names]})
    df['player_upper'] = df['Player'].str.upper()
    if not rankings_df.empty:
        rankings_df['player_upper'] = rankings_df['player'].str.upper()
        merged = pd.merge(df, rankings_df.drop_duplicates('player_upper'), on='player_upper', how='left')
    else:
        merged = df.assign(ranking=None, country="—")
    
    merged['ranking_num'] = pd.to_numeric(merged['ranking'], errors='coerce').fillna(9999)
    merged = merged.sort_values(by='ranking_num', ascending=True).reset_index(drop=True)
    merged['Pos.'] = (merged.index + 1).astype(str)
    
    for col in ['ranking', 'Pos.']:
        merged[col] = merged[col].astype(str).replace(r'\.0$', '', regex=True).replace(['nan', 'None'], '—')
    return merged[['Pos.', 'Player', 'country', 'ranking']].rename(columns={'country': 'Country', 'ranking': 'Rank'})

def scrape_tournament(url, tab_label):
    print(f"Scraping {tab_label}...")
    try:
        r = requests.get(url, headers=HEADERS, timeout=15)
        soup = BeautifulSoup(r.text, 'html.parser')
    except: return None

    full_name = tab_label
    scripts = soup.find_all('script', type='application/ld+json')
    for script in scripts:
        try:
            data = json.loads(script.string)
            if data.get('@type') == 'SportsEvent':
                full_name = clean_tournament_word(data.get('description', tab_label))
                if "DOHA" in tab_label.upper():
                    full_name = "WTA 1000 - Qatar TotalEnergies Open 2026"
                break
        except: continue

    md_rankings = get_rankings_from_api("2026-01-12")
    main_names, qual_names, current_section = [], [], "MAIN"
    for tag in soup.find_all(True):
        tab_attr = tag.get('data-ui-tab')
        if tab_attr == 'Qualifying': current_section = "QUAL"
        elif tab_attr == 'Doubles': current_section = "STOP"
        if current_section == "STOP": continue
        
        player_name = tag.get('data-tracking-player-name')
        if player_name:
            if current_section == "MAIN" and player_name not in main_names: main_names.append(player_name)
            elif current_section == "QUAL" and player_name not in qual_names: qual_names.append(player_name)

    main_df = process_players(main_names, md_rankings)
    qual_df = process_players(qual_names, md_rankings)

    def generate_split_tables(df):
        def apply_highlights(table_df):
            # Convert to HTML
            html = table_df.to_html(index=False, classes="entry-table", border=0)
            # Find <tr> and inject class if country matches LATAM
            rows = html.split('<tr>')
            final_html = [rows[0]]
            for i, content in enumerate(rows[1:]):
                country_val = str(table_df.iloc[i]['Country']).upper()
                if country_val in LATAM_CODES:
                    final_html.append('<tr class="latam-row">' + content)
                else:
                    final_html.append('<tr>' + content)
            return "".join(final_html)

        if len(df) > 25:
            midpoint = (len(df) + 1) // 2
            df1, df2 = df.iloc[:midpoint], df.iloc[midpoint:]
            return (f'<div class="table-column">{apply_highlights(df1)}</div>'
                    f'<div class="table-column">{apply_highlights(df2)}</div>')
        return f'<div class="table-column">{apply_highlights(df)}</div>'

    main_draw_html = f'<div class="main-draw-view">{generate_split_tables(main_df)}</div>'
    qual_html = f'<div class="qual-view" style="display:none;">{generate_split_tables(qual_df)}</div>'

    return {"full_name": full_name, "content": main_draw_html + qual_html}

def main():
    sidebar_html, content_html, is_first = "", "", True

    for week, tournaments in TOURNAMENT_GROUPS.items():
        sidebar_html += f'<div class="week-title">{week}</div>'
        for url, label in tournaments.items():
            data = scrape_tournament(url, label)
            if not data: continue
            tid = label.replace(" ", "_").replace(".", "")
            active_btn, active_div = ("active", "display: block;") if is_first else ("", "display: none;")
            is_first = False

            sidebar_html += f'<button class="tablinks {active_btn}" onclick="openTourney(event, \'{tid}\')">{label}</button>'
            content_html += f"""
            <div id="{tid}" class="tabcontent" style="{active_div}">
                <div class="top-row">
                    <div class="header-controls">
                        <button class="toggle-btn" onclick="toggleView(this)">Switch to Qualifying</button>
                    </div>
                    <div class="title-stack">
                        <div class="sub-title">MAIN DRAW ENTRY LIST</div>
                        <h1 class="main-title">{data["full_name"]}</h1>
                    </div>
                    <div class="spacer"></div>
                </div>
                <div class="tables-row">{data["content"]}</div>
                <div class="logo-container"><img src="LOGO.png" class="tournament-logo"></div>
            </div>"""

    html_template = f"""
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <style>
            @font-face {{ font-family: 'MontserratExtraBold'; src: url('Montserrat-ExtraBold.ttf'); }}
            @font-face {{ font-family: 'MontserratSemiBold'; src: url('Montserrat-SemiBold.ttf'); }}

            body {{ font-family: 'MontserratSemiBold', sans-serif; margin: 0; display: flex; height: 100vh; background: black; }}
            
            .sidebar {{ 
                width: 250px; 
                background-image: url('FondoDegradado.png'); background-size: cover; background-position: left center;
                border-right: 2px solid #ffffff; 
                overflow-y: auto; padding: 10px; flex-shrink: 0; z-index: 10; 
            }}
            .week-title {{ font-family: 'MontserratExtraBold'; padding: 25px 10px 5px; color: white; font-size: 0.9rem; text-transform: uppercase; }}
            .tablinks {{ 
                width: 100%; border: none; background: none; text-align: left; padding: 8px 10px; cursor: pointer; 
                font-size: 0.8rem; font-family: 'MontserratSemiBold', sans-serif;
                background-image: url('FondoDegradado.png'); background-size: cover; background-clip: text;
                -webkit-background-clip: text; color: white; transition: 0.2s;
            }}
            .tablinks.active {{ background: white; color: black; -webkit-background-clip: initial; background-clip: initial; font-family: 'MontserratExtraBold', sans-serif; }}
            
            .main-content {{ 
                flex-grow: 1; overflow-y: auto; padding: 15px 30px; 
                background-image: url('FondoDegradado.png'); background-size: cover; background-position: center; background-attachment: fixed;
                color: white; 
            }}
            
            .top-row {{ 
                display: flex; 
                align-items: center; 
                justify-content: space-between; 
                margin-top: 5px; 
                margin-bottom: 20px; 
            }}
            .header-controls {{ flex: 1; }}
            .spacer {{ flex: 1; }}

            .title-stack {{ flex: 2; text-align: center; }}
            
            .sub-title {{ 
                font-family: 'MontserratExtraBold'; 
                font-size: 1.05rem; 
                color: #ffffff; 
                margin-bottom: 8px; 
                text-transform: uppercase; 
                letter-spacing: 1.5px;
                text-shadow: 2px 2px 4px rgba(0,0,0,0.5);
            }}

            .main-title {{ 
                font-family: 'MontserratExtraBold'; 
                font-size: 1.4rem; 
                margin: 0; 
                text-shadow: 2px 2px 4px rgba(0,0,0,0.5); 
            }}

            .toggle-btn {{
                background: rgba(255, 255, 255, 0.15); border: 1px solid white; color: white;
                padding: 6px 14px; border-radius: 20px; cursor: pointer; font-size: 0.7rem; 
                font-family: 'MontserratSemiBold', sans-serif;
                backdrop-filter: blur(5px);
            }}

            .logo-container {{ text-align: center; margin-top: 25px; padding-bottom: 15px; }}
            .tournament-logo {{ height: 25px; width: auto; filter: drop-shadow(0px 4px 6px rgba(0,0,0,0.3)); }}
            
            .tables-row {{ display: flex; gap: 20px; justify-content: center; width: 100%; }}
            .main-draw-view, .qual-view {{ display: flex; gap: 20px; width: 100%; justify-content: center; }}

            .table-column {{ flex: 1; max-width: 550px; background: transparent; border: 1px solid rgba(255, 255, 255, 0.35); border-radius: 6px; overflow: hidden; }}
            
            .entry-table {{ width: 100%; border-collapse: collapse; color: white; }}
            .entry-table th {{ background: rgba(255, 255, 255, 0.1); padding: 10px 10px; border-bottom: 1px solid rgba(255, 255, 255, 0.25); text-align: center; font-size: 0.8rem; }}
            .entry-table th:nth-child(2) {{ text-align: left; padding-left: 15px; }}
            .entry-table td {{ padding: 7px 8px; border-bottom: 1px solid rgba(255, 255, 255, 0.12); text-align: center; font-size: 0.78rem; }}
            .entry-table td:nth-child(2) {{ text-align: left; padding-left: 15px; }}
            .entry-table tr:nth-child(even) {{ background: rgba(255, 255, 255, 0.04); }}

            /* LATAM HIGHLIGHT RULE */
            .latam-row td {{ font-family: 'MontserratExtraBold' !important; }}

            @media (max-width: 768px) {{
                body {{ flex-direction: column; overflow: auto; }}
                .sidebar {{ width: 100%; height: auto; border-right: none; border-bottom: 2px solid white; display: flex; overflow-x: auto; white-space: nowrap; background-attachment: scroll; }}
                .week-title {{ display: none; }}
                .tablinks {{ width: auto; display: inline-block; padding: 12px 15px; -webkit-background-clip: initial; background-clip: initial; color: white; }}
                .main-content {{ height: auto; overflow: visible; padding: 15px 10px; background-attachment: scroll; }}
                .top-row {{ flex-direction: column; gap: 10px; margin-top: 0; margin-bottom: 15px; }}
                .main-title {{ font-size: 1.2rem; order: 2; }}
                .sub-title {{ font-size: 0.85rem; order: 1; margin-bottom: 4px; }}
                .header-controls {{ order: 3; width: 100%; }}
                .toggle-btn {{ width: 100%; padding: 10px; }}
                .spacer {{ display: none; }}
                .main-draw-view, .qual-view {{ flex-direction: column; align-items: center; }}
                .table-column {{ width: 100%; max-width: 100%; }}
            }}
        </style>
    </head>
    <body>
        <div class="sidebar">{sidebar_html}</div>
        <div class="main-content">{content_html}</div>
        <script>
        function openTourney(evt, tid) {{
            const tc = document.getElementsByClassName("tabcontent");
            for (let i = 0; i < tc.length; i++) tc[i].style.display = "none";
            const tl = document.getElementsByClassName("tablinks");
            for (let i = 0; i < tl.length; i++) tl[i].classList.remove("active");
            document.getElementById(tid).style.display = "block";
            evt.currentTarget.classList.add("active");
        }}

        function toggleView(btn) {{
            const activeTab = btn.closest('.tabcontent');
            const mainView = activeTab.querySelector('.main-draw-view');
            const qualView = activeTab.querySelector('.qual-view');
            const subTitle = activeTab.querySelector('.sub-title');
            const isMain = mainView.style.display !== "none";
            
            mainView.style.display = isMain ? "none" : "flex";
            qualView.style.display = isMain ? "flex" : "none";
            btn.innerText = isMain ? "Switch to Main Draw" : "Switch to Qualifying";
            subTitle.innerText = isMain ? "QUALIFYING ENTRY LIST" : "MAIN DRAW ENTRY LIST";
        }}
        </script>
    </body>
    </html>"""
    
    with open("index.html", "w", encoding="utf-8") as f:
        f.write(html_template)

if __name__ == "__main__":
    main()