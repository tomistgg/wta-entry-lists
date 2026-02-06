import requests
import pandas as pd
import json
import time
import re
import os
from bs4 import BeautifulSoup
from datetime import datetime, timedelta

TOURNAMENT_GROUPS = {
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
LATAM_CODES = ["ARG", "BOL", "BRA", "CHI", "COL", "CRC", "CUB", "DOM", "ECU", "ESA", "GUA", "HON", "MEX", "NCA", "PAN", "PAR", "PER", "PUR", "URU", "VEN"]
STATE_FILE = "player_state.json"
LOG_FILE = "change_log.json"

def load_json(filename):
    if os.path.exists(filename):
        with open(filename, "r", encoding="utf-8") as f:
            try: return json.load(f)
            except: return {}
    return {}

def save_json(filename, data):
    with open(filename, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=4)

def format_pretty_date(date_str):
    try:
        dt = datetime.strptime(date_str, "%Y-%m-%d")
        return dt.strftime("%B %d, %Y")
    except: return date_str

def track_changes(tid, draw_type, current_names, t_name):
    state = load_json(STATE_FILE)
    history = load_json(LOG_FILE)
    key = f"{tid}_{draw_type.replace(' ', '_')}"
    prev_names = set(state.get(key, []))
    curr_names_set = set(current_names)
    today = datetime.now().strftime("%Y-%m-%d")
    new_entries_for_web = []
    notification_for_email = None

    if not prev_names and curr_names_set:
        notification_for_email = f"✨ {t_name} {draw_type} list is now available."
    elif prev_names:
        for name in prev_names:
            if name not in curr_names_set:
                msg = f"<strong>{name.upper()}</strong> removed from {draw_type}"
                new_entries_for_web.append({"date": today, "change": msg})
        for name in curr_names_set:
            if name not in prev_names:
                msg = f"<strong>{name.upper()}</strong> added to {draw_type}"
                new_entries_for_web.append({"date": today, "change": msg})

    if new_entries_for_web:
        if tid not in history: history[tid] = []
        history[tid] = new_entries_for_web + history[tid]
        save_json(LOG_FILE, history)
    
    state[key] = list(current_names)
    save_json(STATE_FILE, state)

    email_updates = []
    if notification_for_email:
        email_updates.append(notification_for_email)
    for entry in new_entries_for_web:
        clean_msg = re.sub('<[^<]+?>', '', entry['change'])
        email_updates.append(clean_msg)
    return email_updates

def clean_tournament_word(text):
    if not text: return ""
    return re.sub(r'\bTournament\b', '', text, flags=re.IGNORECASE).strip()

def get_rankings_from_api(date_str):
    all_players, page = [], 0
    while True:
        params = {"metric": "SINGLES", "type": "rankSingles", "sort": "asc", "at": date_str, "pageSize": 100, "page": page}
        try:
            r = requests.get(API_URL, params=params, headers=HEADERS, timeout=10)
            data = r.json()
            items = data.get('content', []) if isinstance(data, dict) else data
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

def scrape_tournament(url, tab_label, tid):
    print(f"Scraping {tab_label}...")
    try:
        r = requests.get(url, headers=HEADERS, timeout=15)
        soup = BeautifulSoup(r.text, 'html.parser')
    except: return None
    
    full_name = tab_label
    start_date_str = None
    scripts = soup.find_all('script', type='application/ld+json')
    for script in scripts:
        try:
            data = json.loads(script.string)
            if data.get('@type') == 'SportsEvent':
                full_name = clean_tournament_word(data.get('description', tab_label))
                start_date_str = data.get('startDate')
                break
        except: continue

    if not start_date_str: start_date_str = "2026-02-16"
    start_dt = datetime.strptime(start_date_str[:10], "%Y-%m-%d")
    tourney_monday = start_dt - timedelta(days=start_dt.weekday())
    is_weekend_start = start_dt.weekday() >= 5
    md_ranking_date = (tourney_monday - timedelta(weeks=(3 if is_weekend_start else 4))).strftime("%Y-%m-%d")
    qual_ranking_date = (tourney_monday - timedelta(weeks=(2 if is_weekend_start else 3))).strftime("%Y-%m-%d")
    
    avail_md_dt = datetime.strptime(md_ranking_date, "%Y-%m-%d")
    friday_md_str = (avail_md_dt + timedelta(days=4)).strftime("%Y-%m-%d")
    avail_qual_dt = datetime.strptime(qual_ranking_date, "%Y-%m-%d")
    friday_qual_str = (avail_qual_dt + timedelta(days=4)).strftime("%Y-%m-%d")

    md_rankings = get_rankings_from_api(md_ranking_date)
    qual_rankings = get_rankings_from_api(qual_ranking_date)

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
    qual_df = process_players(qual_names, qual_rankings)

    run_notifications = []
    if not main_df.empty:
        run_notifications.extend(track_changes(tid, "Main Draw", main_df['Player'].tolist(), full_name))
    if not qual_df.empty:
        run_notifications.extend(track_changes(tid, "Qualifying", qual_df['Player'].tolist(), full_name))

    def get_display_content(df, tid, draw_type, availability_date):
        key = f"{tid}_{draw_type.replace(' ', '_')}"
        if df.empty and not load_json(STATE_FILE).get(key):
            pretty_date = format_pretty_date(availability_date)
            return f"<p style='text-align:center; padding:40px; opacity:0.6;'>This list will most likely be available on the WTA website on {pretty_date}</p>"
        
        def apply_highlights(table_df):
            html = table_df.to_html(index=False, classes="entry-table", border=0)
            rows = html.split('<tr>')
            final_html = [rows[0]]
            for i, content in enumerate(rows[1:]):
                country_val = str(table_df.iloc[i]['Country']).upper()
                if country_val in LATAM_CODES: final_html.append('<tr class="latam-row">' + content)
                else: final_html.append('<tr>' + content)
            return "".join(final_html)

        if len(df) > 25:
            midpoint = (len(df) + 1) // 2
            df1, df2 = df.iloc[:midpoint], df.iloc[midpoint:]
            return (f'<div class="table-column">{apply_highlights(df1)}</div>'
                    f'<div class="table-column">{apply_highlights(df2)}</div>')
        return f'<div class="table-column">{apply_highlights(df)}</div>'

    main_draw_html = f'<div class="main-draw-view">{get_display_content(main_df, tid, "Main Draw", friday_md_str)}</div>'
    qual_html = f'<div class="qual-view" style="display:none;">{get_display_content(qual_df, tid, "Qualifying", friday_qual_str)}</div>'
    
    history = load_json(LOG_FILE).get(tid, [])
    if not history:
        changes_body = "<p style='text-align:center; padding:40px; opacity:0.6;'>No changes recorded yet.</p>"
    else:
        changes_body = '<div class="table-column" style="max-width:550px; margin: 0 auto;"><table class="entry-table"><thead><tr><th>DATE</th><th style="text-align:left; padding-left:20px;">CHANGE</th></tr></thead><tbody>'
        for entry in history:
            changes_body += f'<tr><td>{entry["date"]}</td><td style="text-align:left; padding-left:20px;">{entry["change"]}</td></tr>'
        changes_body += '</tbody></table></div>'
    
    changes_view_html = f'<div class="changes-view" style="display:none; justify-content: center;">{changes_body}</div>'
    return {"full_name": full_name, "content": main_draw_html + qual_html + changes_view_html, "notifications": run_notifications}

def main():
    old_content = {}
    try:
        with open("index.html", "r", encoding="utf-8") as f:
            old_html = f.read()
            found_old = re.findall(r'<div id="(.*?)" class="tabcontent".*?>(.*?)', old_html, re.DOTALL)
            for tid, content in found_old: old_content[tid] = content.strip()
    except FileNotFoundError: pass

    sidebar_html, content_html, is_first, all_email_alerts = "", "", True, []
    for week, tournaments in TOURNAMENT_GROUPS.items():
        sidebar_html += f'<div class="week-title">{week}</div>'
        for url, label in tournaments.items():
            tid = label.replace(" ", "_").replace(".", "")
            data = scrape_tournament(url, label, tid)
            if data and data.get("notifications"):
                clean_tid = tid.replace("_", " ")
                alert_block = f"Tournament: {clean_tid}\n" + "\n".join(f"- {n}" for n in data["notifications"])
                all_email_alerts.append(alert_block)
            
            has_new_data = data and ("<tr>" in data.get("content", "") or "WTA website" in data.get("content", ""))
            if has_new_data:
                current_tourney_body = f"""
                <div class="top-row">
                    <div class="header-controls">
                        <button class="toggle-btn main-qual-toggle" onclick="toggleView(this)">Switch to Qualifying</button>
                        <button class="toggle-btn changes-btn" onclick="showChanges(this, '{tid}')">Changes List</button>
                        <button class="toggle-btn back-to-qual-btn" style="display:none;" onclick="showQualFromChanges(this)">Switch to Qualifying</button>
                    </div>
                    <div class="title-stack">
                        <div class="sub-title">MAIN DRAW ENTRY LIST</div>
                        <h1 class="main-title">{data["full_name"]}</h1>
                    </div>
                    <div class="spacer"></div>
                </div>
                <div class="tables-row">{data["content"]}</div>
                <div class="logo-container"><img src="LOGO.png" class="tournament-logo"></div>
                """
            elif tid in old_content: current_tourney_body = old_content[tid]
            else: continue
            active_btn, active_div = ("active", "display: block;") if is_first else ("", "display: none;")
            is_first = False
            sidebar_html += f'<button class="tablinks {active_btn}" onclick="openTourney(event, \'{tid}\')">{label}</button>'
            content_html += f'<div id="{tid}" class="tabcontent" style="{active_div}">{current_tourney_body}</div>'

    html_template = f"""<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no"><meta name="color-scheme" content="dark only"><style>@font-face {{ font-family: 'MontserratExtraBold'; src: url('Montserrat-ExtraBold.ttf'); }} @font-face {{ font-family: 'MontserratSemiBold'; src: url('Montserrat-SemiBold.ttf'); }} :root {{ color-scheme: dark; }} * {{ -webkit-tap-highlight-color: transparent; box-sizing: border-box; }} body {{ font-family: 'MontserratSemiBold', sans-serif; margin: 0; display: flex; height: 100vh; background: black; color: white; }} .sidebar {{ width: 250px; background-image: url('FondoDegradado.png'); background-size: cover; background-position: left center; border-right: 2px solid #ffffff; overflow-y: auto; padding: 10px; flex-shrink: 0; z-index: 10; }} .week-title {{ font-family: 'MontserratExtraBold'; padding: 25px 10px 5px; color: white; font-size: 0.9rem; text-transform: uppercase; }} .tablinks {{ width: 100%; border: none; background: none; text-align: left; padding: 8px 10px; cursor: pointer; font-size: 0.8rem; font-family: 'MontserratSemiBold', sans-serif; background-image: url('FondoDegradado.png'); background-size: cover; background-clip: text; -webkit-background-clip: text; color: white; transition: 0.2s; }} .tablinks.active {{ background: white; color: black; -webkit-background-clip: initial; background-clip: initial; font-family: 'MontserratExtraBold', sans-serif; }} .main-content {{ flex-grow: 1; overflow-y: auto; padding: 15px 30px; background-image: url('FondoDegradado.png'); background-size: cover; background-position: center; background-attachment: fixed; color: white; }} .top-row {{ display: flex; align-items: center; justify-content: space-between; margin-top: 5px; margin-bottom: 20px; height: 80px; }} .header-controls {{ flex: 1; display: flex; flex-direction: column; gap: 6px; }} .spacer {{ flex: 1; }} .title-stack {{ flex: 2; text-align: center; display: flex; flex-direction: column; justify-content: center; }} .sub-title {{ font-family: 'MontserratExtraBold'; font-size: 1.05rem; color: #ffffff; margin-bottom: 8px; text-transform: uppercase; letter-spacing: 1.5px; text-shadow: 2px 2px 4px rgba(0,0,0,0.5); }} .main-title {{ font-family: 'MontserratExtraBold'; font-size: 1.4rem; margin: 0; text-shadow: 2px 2px 4px rgba(0,0,0,0.5); }} .toggle-btn {{ background: rgba(255, 255, 255, 0.15); border: 1px solid white; color: white; height: 32px; width: 170px; border-radius: 20px; cursor: pointer; font-size: 0.68rem; font-family: 'MontserratSemiBold', sans-serif; backdrop-filter: blur(5px); text-align: center; }} .logo-container {{ text-align: center; margin-top: 25px; padding-bottom: 15px; }} .tournament-logo {{ height: 25px; width: auto; filter: drop-shadow(0px 4px 6px rgba(0,0,0,0.3)); }} .tables-row {{ display: flex; gap: 20px; justify-content: center; width: 100%; }} .main-draw-view, .qual-view, .changes-view {{ display: flex; gap: 20px; width: 100%; justify-content: center; }} .table-column {{ flex: 1; max-width: 550px; background: transparent; border: 1px solid rgba(255, 255, 255, 0.35); border-radius: 6px; overflow: hidden; }} .entry-table {{ width: 100%; border-collapse: collapse; color: white; }} .entry-table th {{ background: rgba(255, 255, 255, 0.1); padding: 10px 10px; border-bottom: 1px solid rgba(255, 255, 255, 0.25); text-align: center; font-size: 0.8rem; }} .entry-table td {{ padding: 7px 8px; border-bottom: 1px solid rgba(255, 255, 255, 0.12); text-align: center; font-size: 0.78rem; }} .entry-table tr:nth-child(even) {{ background: rgba(255, 255, 255, 0.04); }} .latam-row td {{ font-family: 'MontserratExtraBold' !important; }} @media (max-width: 768px) {{ body {{ flex-direction: column; overflow-x: hidden; overflow-y: auto; background: black; }} .sidebar {{ width: 100%; height: auto; display: flex; overflow-x: auto; white-space: nowrap; padding: 10px 8px; gap: 8px; }} .tablinks {{ width: auto; display: inline-block; padding: 8px 16px; border: 1px solid rgba(255, 255, 255, 0.4); border-radius: 20px; font-size: 0.75rem; }} .main-content {{ padding: 15px 10px 100px; }} .top-row {{ flex-direction: column; height: auto; gap: 15px; }} .main-draw-view, .qual-view, .changes-view {{ flex-direction: column; align-items: center; }} }}</style></head><body><div class="sidebar">{sidebar_html}</div><div class="main-content">{content_html}</div><script>function openTourney(evt, tid) {{ const tc = document.getElementsByClassName("tabcontent"); for (let i = 0; i < tc.length; i++) tc[i].style.display = "none"; const tl = document.getElementsByClassName("tablinks"); for (let i = 0; i < tl.length; i++) tl[i].classList.remove("active"); document.getElementById(tid).style.display = "block"; evt.currentTarget.classList.add("active"); }} function toggleView(btn) {{ const activeTab = btn.closest('.tabcontent'); const mainView = activeTab.querySelector('.main-draw-view'); const qualView = activeTab.querySelector('.qual-view'); const changesView = activeTab.querySelector('.changes-view'); const subTitle = activeTab.querySelector('.sub-title'); if (changesView.style.display === "flex") {{ changesView.style.display = "none"; activeTab.querySelector('.changes-btn').style.display = "block"; activeTab.querySelector('.back-to-qual-btn').style.display = "none"; }} const isMain = mainView.style.display !== "none"; mainView.style.display = isMain ? "none" : "flex"; qualView.style.display = isMain ? "flex" : "none"; btn.innerText = isMain ? "Switch to Main Draw" : "Switch to Qualifying"; subTitle.innerText = isMain ? "QUALIFYING ENTRY LIST" : "MAIN DRAW ENTRY LIST"; }} function showChanges(btn, tid) {{ const activeTab = document.getElementById(tid); activeTab.querySelector('.main-draw-view').style.display = "none"; activeTab.querySelector('.qual-view').style.display = "none"; activeTab.querySelector('.changes-view').style.display = "flex"; activeTab.querySelector('.sub-title').innerText = "LIST OF CHANGES"; btn.style.display = "none"; activeTab.querySelector('.main-qual-toggle').innerText = "Switch to Main Draw"; activeTab.querySelector('.back-to-qual-btn').style.display = "block"; }} function showQualFromChanges(btn) {{ const activeTab = btn.closest('.tabcontent'); activeTab.querySelector('.changes-view').style.display = "none"; activeTab.querySelector('.qual-view').style.display = "flex"; activeTab.querySelector('.sub-title').innerText = "QUALIFYING ENTRY LIST"; btn.style.display = "none"; activeTab.querySelector('.changes-btn').style.display = "block"; activeTab.querySelector('.main-qual-toggle').innerText = "Switch to Main Draw"; }}</script></body></html>"""
    with open("index.html", "w", encoding="utf-8") as f: f.write(html_template)
    if all_email_alerts:
        with open("email_body.txt", "w", encoding="utf-8") as f:
            f.write("The following changes were detected:\n\n" + "\n\n".join(all_email_alerts) + "\n\nCheck your site: https://your-username.github.io/your-repo/")
    else:
        if os.path.exists("email_body.txt"): os.remove("email_body.txt")

if __name__ == "__main__": main()
