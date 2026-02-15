import requests
import pandas as pd
import json
import time
import re
import os
from bs4 import BeautifulSoup
from datetime import datetime, timedelta
import unicodedata

def get_next_monday():
    today = datetime.now()
    days_until_monday = (7 - today.weekday()) % 7
    if days_until_monday == 0:
        days_until_monday = 7
    next_mon = today + timedelta(days=days_until_monday)
    return next_mon.replace(hour=0, minute=0, second=0, microsecond=0)

def get_monday_from_date(date_str):
    date = datetime.strptime(date_str, "%Y-%m-%d")
    weekday = date.weekday()
    
    if weekday >= 5:
        days_until_monday = 7 - weekday
        monday = date + timedelta(days=days_until_monday)
    else:
        days_since_monday = weekday
        monday = date - timedelta(days=days_since_monday)
    
    return monday

def format_week_label(monday_date):
    months_es = {
        1: "Enero", 2: "Febrero", 3: "Marzo", 4: "Abril",
        5: "Mayo", 6: "Junio", 7: "Julio", 8: "Agosto",
        9: "Septiembre", 10: "Octubre", 11: "Noviembre", 12: "Diciembre"
    }
    return f"Semana {monday_date.day} {months_es[monday_date.month]}"

def build_tournament_groups():
    next_monday = get_next_monday()
    four_weeks_later = next_monday + timedelta(weeks=4)
    
    from_date = (next_monday - timedelta(days=7)).strftime("%Y-%m-%d")
    to_date = four_weeks_later.strftime("%Y-%m-%d")
    
    url = "https://api.wtatennis.com/tennis/tournaments/"
    
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36",
        "referer": "https://www.wtatennis.com/",
        "account": "wta"
    }
    
    params = {
        "page": 0,
        "pageSize": 30,
        "excludeLevels": "ITF",
        "from": from_date,
        "to": to_date
    }
    
    try:
        response = requests.get(url, headers=headers, params=params, timeout=10)
        data = response.json()
    except Exception as e:
        print(f"Error fetching tournaments: {e}")
        return {}
    
    tournament_groups = {}
    
    for tournament in data.get("content", []):
        tournament_id = tournament["tournamentGroup"]["id"]
        raw_name = tournament["tournamentGroup"]["name"]
        
        nfkd_form = unicodedata.normalize('NFKD', raw_name)
        clean_name = "".join([c for c in nfkd_form if not unicodedata.combining(c)])

        suffix = ""
        if "#" in clean_name:
            parts = clean_name.split("#")
            clean_name = parts[0].strip()
            suffix = " " + parts[1].strip()
        
        name = clean_name.lower().replace(" ", "-").replace("'", "-")
        if suffix:
            name += "-" + suffix.strip()
        
        year = tournament["year"]
        level = tournament["level"]
        city = tournament["city"].title()
        start_date = tournament["startDate"]
        
        monday = get_monday_from_date(start_date)
        
        if not (next_monday <= monday < four_weeks_later):
            continue
        
        week_label = format_week_label(monday)
        
        url = f"https://www.wtatennis.com/tournaments/{tournament_id}/{name}/{year}/player-list"
        display_name = f"{level} {city}{suffix}"
        
        if week_label not in tournament_groups:
            tournament_groups[week_label] = {}
        
        # Store tournament with its level for sorting later
        tournament_groups[week_label][url] = {
            "name": display_name,
            "level": level
        }
    
    return tournament_groups

TOURNAMENT_GROUPS = build_tournament_groups()

API_URL = "https://api.wtatennis.com/tennis/players/ranked"
HEADERS = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36"}
LATAM_CODES = ["ARG", "BOL", "BRA", "CHI", "COL", "CRC", "CUB", "DOM", "ECU", "ESA", "GUA", "HON", "MEX", "NCA", "PAN", "PAR", "PER", "PUR", "URU", "VEN"]
STATE_FILE = "player_state.json"
LOG_FILE = "change_log.json"

PLAYER_OVERRIDES = {
    "CATHERINE HARRISON": {"country": "USA"}
}

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

def get_display_content(df, tid, draw_type, availability_date):
    key = f"{tid.upper()}_{draw_type.replace(' ', '_').upper()}"
    
    if df.empty:
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

    total_players = len(df)
    
    if total_players > 50:
        size = (total_players + 2) // 3
        col1 = df.iloc[:size]
        col2 = df.iloc[size:size*2]
        col3 = df.iloc[size*2:]
        return (f'<div class="table-column">{apply_highlights(col1)}</div>'
                f'<div class="table-column">{apply_highlights(col2)}</div>'
                f'<div class="table-column">{apply_highlights(col3)}</div>')
    
    elif total_players > 25:
        midpoint = (total_players + 1) // 2
        return (f'<div class="table-column">{apply_highlights(df.iloc[:midpoint])}</div>'
                f'<div class="table-column">{apply_highlights(df.iloc[midpoint:])}</div>')
    
    return f'<div class="table-column">{apply_highlights(df)}</div>'

def track_changes(tid, draw_type, current_names, t_name, skip_notifications=False):
    state = load_json(STATE_FILE)
    history = load_json(LOG_FILE)
    key = f"{tid.upper()}_{draw_type.replace(' ', '_').upper()}"
    prev_names = set(state.get(key, []))
    curr_names_set = set(current_names)
    today = datetime.now().strftime("%Y-%m-%d")
    new_entries_for_web = []
    notification_for_email = None

    if not skip_notifications:
        if not prev_names and curr_names_set:
            notification_for_email = f"{t_name} {draw_type} list is now available."
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
    
    if current_names or not prev_names:
        state[key] = list(current_names)
        save_json(STATE_FILE, state)

    email_updates = []
    if notification_for_email: email_updates.append(notification_for_email)
    for entry in new_entries_for_web:
        clean_msg = re.sub('<[^<]+?>', '', entry['change'])
        email_updates.append(clean_msg)
    return email_updates

def process_players(players, rankings_df):
    if not players: return pd.DataFrame(columns=['Pos.', 'Player', 'Country', 'Rank'])

    # Normalize: accept list of strings (cache) or list of dicts (API)
    if isinstance(players[0], str):
        players = [{"name": p, "country": None} for p in players]

    processed_data = []
    rankings_dict = {}
    if not rankings_df.empty:
        rankings_dict = rankings_df.drop_duplicates(subset=['player']).set_index(rankings_df['player'].drop_duplicates().str.upper()).to_dict('index')

    for player in players:
        clean_name = player["name"].strip().title()
        upper_name = clean_name.upper()

        rank_info = rankings_dict.get(upper_name, {})
        country = player.get("country") or rank_info.get('country', '-')
        rank = str(rank_info.get('ranking', '-'))

        if upper_name in PLAYER_OVERRIDES:
            country = PLAYER_OVERRIDES[upper_name].get('country', country)

        if rank.lower() in ['nan', 'none', '']:
            rank = '-'
        else:
            rank = rank.replace('.0', '')

        processed_data.append({
            'Player': clean_name,
            'Country': country,
            'Rank': rank,
            'rank_sort': 9999 if rank == '-' else int(rank)
        })

    df = pd.DataFrame(processed_data)
    df = df.sort_values('rank_sort').reset_index(drop=True)
    df['Pos.'] = (df.index + 1).astype(str)

    return df[['Pos.', 'Player', 'Country', 'Rank']]

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

def fetch_player_info(player_id):
    url = f"https://api.wtatennis.com/tennis/players/{player_id}/matches"
    params = {"page": 0, "pageSize": 1, "sort": "desc"}
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36",
        "referer": "https://www.wtatennis.com/",
        "account": "wta"
    }
    try:
        r = requests.get(url, params=params, headers=headers, timeout=10)
        data = r.json()
        player = data.get("player", {})
        name = player.get("fullName")
        country = player.get("countryCode")
        if name:
            return {"name": name, "country": country}
    except:
        pass
    return None

def scrape_tournament(url, tab_label, tid):
    tid = tid.upper().replace(" ", "_").replace(".", "").replace("-", "_").replace("'", "")
    print(f"Scraping {tab_label}...")
    try:
        r = requests.get(url, headers=HEADERS, timeout=15)
        soup = BeautifulSoup(r.text, 'html.parser')
    except: return None
    
    full_name = tab_label
    scripts = soup.find_all('script', type='application/ld+json')
    start_date_str = "2026-02-16"
    for script in scripts:
        try:
            data = json.loads(script.string)
            if data.get('@type') == 'SportsEvent':
                full_name = re.sub(r'\bTournament\b', '', data.get('description', tab_label), flags=re.IGNORECASE).strip()
                start_date_str = data.get('startDate')[:10]
                
                edition_match = re.search(r'(\d+)$', tab_label)
                if edition_match:
                    num = edition_match.group(1)
                    pattern = rf'\b{num}\b'
                    if not re.search(pattern, full_name):
                        full_name = f"{full_name} {num}"
                break
        except: continue

    start_dt = datetime.strptime(start_date_str, "%Y-%m-%d")
    tourney_monday = start_dt - timedelta(days=start_dt.weekday())
    is_weekend = start_dt.weekday() >= 5
    md_date = (tourney_monday - timedelta(weeks=(3 if is_weekend else 4))).strftime("%Y-%m-%d")
    qual_date = (tourney_monday - timedelta(weeks=(2 if is_weekend else 3))).strftime("%Y-%m-%d")
    fri_md = (datetime.strptime(md_date, "%Y-%m-%d") + timedelta(days=4)).strftime("%Y-%m-%d")
    fri_qual = (datetime.strptime(qual_date, "%Y-%m-%d") + timedelta(days=4)).strftime("%Y-%m-%d")

    md_rankings = get_rankings_from_api(md_date)
    qual_rankings = get_rankings_from_api(qual_date)

    main_ids, qual_ids, section = [], [], "MAIN"
    for tag in soup.find_all(True):
        attr = tag.get('data-ui-tab')
        if attr == 'Qualifying': section = "QUAL"
        elif attr == 'Doubles': section = "STOP"
        if section == "STOP": continue
        href = tag.get('href', '')
        match = re.match(r'/players/(\d+)/', href)
        if match:
            player_id = match.group(1)
            if section == "MAIN" and player_id not in main_ids: main_ids.append(player_id)
            elif section == "QUAL" and player_id not in qual_ids: qual_ids.append(player_id)

    # Fetch player info from API for all unique IDs
    all_ids = list(dict.fromkeys(main_ids + qual_ids))
    player_cache = {}
    for pid in all_ids:
        info = fetch_player_info(pid)
        if info:
            player_cache[pid] = info
        time.sleep(0.05)

    main_players = [player_cache[pid] for pid in main_ids if pid in player_cache]
    qual_players = [player_cache[pid] for pid in qual_ids if pid in player_cache]

    used_cached_main = False
    if not main_players and qual_players:
        state = load_json(STATE_FILE)
        md_key = f"{tid}_MAIN_DRAW"
        if state.get(md_key):
            main_players = state[md_key]
            used_cached_main = True

    main_df = process_players(main_players, md_rankings)
    qual_df = process_players(qual_players, qual_rankings)
    
    run_notifications = []
    run_notifications.extend(track_changes(tid, "Main Draw", main_df['Player'].tolist(), full_name, skip_notifications=used_cached_main))
    run_notifications.extend(track_changes(tid, "Qualifying", qual_df['Player'].tolist(), full_name))

    main_draw_html = f'<div class="main-draw-view">{get_display_content(main_df, tid, "Main Draw", fri_md)}</div>'
    qual_html = f'<div class="qual-view" style="display:none;">{get_display_content(qual_df, tid, "Qualifying", fri_qual)}</div>'
    
    current_history = load_json(LOG_FILE)
    fresh_history = current_history.get(tid, [])
    if not fresh_history:
        changes_body = "<p style='text-align:center; padding:40px; opacity:0.6;'>No changes recorded yet.</p>"
    else:
        rows = "".join([f'<tr><td>{e["date"]}</td><td style="text-align:left; padding-left:20px;">{e["change"]}</td></tr>' for e in fresh_history])
        changes_body = f'<div class="table-column" style="max-width:550px; margin: 0 auto;"><table class="entry-table"><thead><tr><th>DATE</th><th style="text-align:left; padding-left:20px;">CHANGE</th></tr></thead><tbody>{rows}</tbody></table></div>'
    
    return {"full_name": full_name, "content": main_draw_html + qual_html + f'<div class="changes-view" style="display:none; justify-content: center;">{changes_body}</div>', "notifications": run_notifications}

def main():
    old_content = {}
    if os.path.exists("index.html"):
        with open("index.html", "r", encoding="utf-8") as f:
            try:
                old_html = f.read()
                found = re.findall(r'<div id="(.*?)" class="tabcontent".*?>(.*?)', old_html, re.DOTALL)
                for tid, content in found: old_content[tid] = content.strip()
            except: pass

    sidebar_html, content_html, is_first, all_alerts = "", "", True, []
    
    for week, tourneys in TOURNAMENT_GROUPS.items():
        sidebar_html += f'<div class="week-title">{week}</div>'
        for url, info in tourneys.items():
            # Extract the actual string name from the info dictionary
            label = info["name"] 
            
            tid = label.replace(" ", "_").replace(".", "").replace("-", "_").replace("'", "").upper()
            data = scrape_tournament(url, label, tid)
            
            if data and data.get("notifications"):
                all_alerts.append(f"Tournament: {label}\n" + "\n".join(f"- {n}" for n in data["notifications"]))
            
            if data:
                body = f'''
                <div class="top-row">
                    <div class="header-controls">
                        <button class="toggle-btn main-qual-toggle" onclick="toggleView(this)">Qualifying</button>
                        <button class="toggle-btn changes-btn" onclick="showChanges(this, '{tid}')">Changes</button>
                        <button class="toggle-btn back-to-qual-btn" style="display:none;" onclick="showQualFromChanges(this)">Qualifying</button>
                    </div>
                    <div class="title-stack">
                        <div class="sub-title">MAIN DRAW ENTRY LIST</div>
                        <h1 class="main-title">{data["full_name"]}</h1>
                    </div>
                    <div class="pdf-container">
                        <button class="toggle-btn pdf-btn" onclick="exportToPDF('{tid}')">PDF</button>
                    </div>
                </div>
                {data["content"]}
                <div class="logo-container"><img src="LOGO.png" class="tournament-logo"></div>
                '''
            elif tid in old_content: 
                body = old_content[tid]
            else: 
                continue

            active_btn, active_div = ("active", "display: block;") if is_first else ("", "display: none;")
            is_first = False
            sidebar_html += f'<button class="tablinks {active_btn}" onclick="openTourney(event, \'{tid}\')">{label}</button>'
            content_html += f'<div id="{tid}" class="tabcontent" style="{active_div}">{body}</div>'

    full_site_html = f"""<!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
        <style>
            @font-face {{ font-family: 'MontserratExtraBold'; src: url('Montserrat-ExtraBold.ttf'); }}
            @font-face {{ font-family: 'MontserratSemiBold'; src: url('Montserrat-SemiBold.ttf'); }}
            :root {{ color-scheme: dark; }}
            * {{ box-sizing: border-box; -webkit-tap-highlight-color: transparent; }}
            body {{ font-family: 'MontserratSemiBold', sans-serif; margin: 0; display: flex; height: 100vh; background: black; color: white; }}
            .sidebar {{ width: 250px; background-image: url('FondoDegradado.png'); background-size: cover; background-position: left center; border-right: 2px solid #ffffff; overflow-y: auto; padding: 10px; flex-shrink: 0; z-index: 10; }}
            .week-title {{ font-family: 'MontserratExtraBold'; padding: 25px 10px 5px; color: white; font-size: 0.9rem; text-transform: uppercase; }}
            .tablinks {{ width: 100%; border: none; background: none; text-align: left; padding: 8px 10px; cursor: pointer; font-size: 0.8rem; font-family: 'MontserratSemiBold', sans-serif; background-image: url('FondoDegradado.png'); background-size: cover; background-clip: text; -webkit-background-clip: text; color: white; transition: 0.2s; }}
            .tablinks.active {{ background: white; color: black; -webkit-background-clip: initial; background-clip: initial; font-family: 'MontserratExtraBold', sans-serif; }}
            .main-content {{ flex-grow: 1; overflow-y: auto; padding: 15px 20px; background-image: url('FondoDegradado.png'); background-size: cover; background-attachment: fixed; }}
            .top-row {{ display: flex; align-items: center; justify-content: space-between; margin-bottom: 20px; }}
            .header-controls {{ display: flex; flex-direction: column; gap: 6px; flex: 1; }}
            .title-stack {{ flex: 2; text-align: center; min-width: 0; }}
            .sub-title {{ font-family: 'MontserratExtraBold'; font-size: 1.05rem; letter-spacing: 1.5px; text-shadow: 2px 2px 4px rgba(0,0,0,0.5); }}
            .main-title {{ font-family: 'MontserratExtraBold'; font-size: 1.4rem; margin: 0; text-shadow: 2px 2px 4px rgba(0,0,0,0.5); }}
            .toggle-btn {{ background: rgba(255, 255, 255, 0.15); border: 1px solid white; color: white; height: 32px; width: 110px; border-radius: 20px; cursor: pointer; font-size: 0.75rem; font-family: 'MontserratSemiBold', sans-serif; backdrop-filter: blur(5px); text-align: center; box-sizing: border-box; }}
            .tables-row {{ display: flex; gap: 20px; justify-content: center; width: 100%; }}
            .main-draw-view, .qual-view, .changes-view {{ display: flex; gap: 20px; width: 100%; justify-content: center; }}
            .table-column {{ flex: 1; min-width: 280px; max-width: 450px; border: 1px solid rgba(255,255,255,0.35); border-radius: 6px; overflow: hidden; background: rgba(0,0,0,0.2); }}
            .entry-table {{ width: 100%; border-collapse: collapse; color: white; }}
            .entry-table th {{ background: rgba(255, 255, 255, 0.1); padding: 9px 9px; border-bottom: 1px solid rgba(255, 255, 255, 0.25); text-align: center; font-size: 0.8rem; }}
            .entry-table td {{ padding: 6px; border-bottom: 1px solid rgba(255,255,255,0.12); text-align: center; font-size: 0.78rem; }}
            .latam-row td {{ font-family: 'MontserratExtraBold' !important; color: #fff; }}
            .logo-container {{ text-align: center; margin-top: 25px; }}
            .pdf-container {{ flex: 1; display: flex; justify-content: flex-end; }}
            .tournament-logo {{ height: 25px; }}
            .spacer {{ flex: 1; }}
            .pdf-btn {{ width: 60px !important; }}
            .is-exporting .header-controls, 
            .is-exporting .pdf-btn,
            .is-exporting .spacer {{ display: none !important; }}
            .is-exporting .top-row {{ justify-content: center !important; display: flex !important; width: 100% !important; }}
            .is-exporting .title-stack {{ flex: 0 0 100% !important; max-width: 100% !important; margin: 0 auto !important; padding: 0 !important; }}
            @media print {{ .main-content {{ background: black !important; color: white !important; }} }}
            @media (max-width: 768px) {{
                body {{ flex-direction: column; }}
                .sidebar {{ width: 100%; height: auto; display: flex; overflow-x: auto; white-space: nowrap; align-items: center; padding: 5px; }}
                .week-title {{ display: inline-block !important; padding: 0 10px !important; margin: 0 !important; font-size: 0.7rem !important; line-height: 1.2 !important; text-align: center !important; max-width: 55px !important; white-space: normal !important; word-spacing: 100px !important; flex-shrink: 0; text-transform: uppercase; }}
                .tablinks {{ width: auto; display: inline-block; padding: 10px 15px; border: 1px solid rgba(255,255,255,0.3); border-radius: 20px; margin-right: 5px; flex-shrink: 0; vertical-align: middle; }}
                .main-content {{ padding: 10px; }}
                .tables-row, .main-draw-view, .qual-view, .changes-view {{ flex-direction: column; align-items: center; }}
                .top-row {{ display: flex !important; flex-direction: row !important; flex-wrap: wrap; justify-content: center !important; height: auto; gap: 8px; }}
                .header-controls, .pdf-container {{ display: contents !important; }}
                .toggle-btn {{ order: 1 !important; margin: 0 !important; }}
                .title-stack {{ order: 2 !important; flex: 0 0 100% !important; width: 100%; text-align: center; margin-top: 10px;}}
            }}
        </style>
        <script src="https://cdnjs.cloudflare.com/ajax/libs/html2pdf.js/0.10.1/html2pdf.bundle.min.js"></script>
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
                const changesView = activeTab.querySelector('.changes-view');
                const subTitle = activeTab.querySelector('.sub-title');
                if (changesView.style.display === "flex") {{
                    changesView.style.display = "none";
                    activeTab.querySelector('.changes-btn').style.display = "block";
                    activeTab.querySelector('.back-to-qual-btn').style.display = "none";
                }}
                const isMain = mainView.style.display !== "none";
                mainView.style.display = isMain ? "none" : "flex";
                qualView.style.display = isMain ? "flex" : "none";
                btn.innerText = isMain ? "Main Draw" : "Qualifying";
                subTitle.innerText = isMain ? "QUALIFYING ENTRY LIST" : "MAIN DRAW ENTRY LIST";
            }}
            function showChanges(btn, tid) {{
                const activeTab = document.getElementById(tid);
                activeTab.querySelector('.main-draw-view').style.display = "none";
                activeTab.querySelector('.qual-view').style.display = "none";
                activeTab.querySelector('.changes-view').style.display = "flex";
                activeTab.querySelector('.sub-title').innerText = "LIST OF CHANGES";
                btn.style.display = "none";
                activeTab.querySelector('.main-qual-toggle').innerText = "Main Draw";
                activeTab.querySelector('.back-to-qual-btn').style.display = "block";
            }}
            function showQualFromChanges(btn) {{
                const activeTab = btn.closest('.tabcontent');
                activeTab.querySelector('.changes-view').style.display = "none";
                activeTab.querySelector('.qual-view').style.display = "flex";
                activeTab.querySelector('.sub-title').innerText = "QUALIFYING ENTRY LIST";
                btn.style.display = "none";
                activeTab.querySelector('.changes-btn').style.display = "block";
                activeTab.querySelector('.main-qual-toggle').innerText = "Main Draw";
            }}
            function exportToPDF() {{
                const element = document.querySelector('.main-content');
                document.body.classList.add('is-exporting');
                
                const title = document.querySelector('.main-title').innerText;
                const subTitle = document.querySelector('.sub-title').innerText;
                
                const opt = {{
                    margin:       0,
                    filename:     'entry-list.pdf',
                    image:        {{ type: 'jpeg', quality: 0.98 }},
                    html2canvas:  {{ scale: 1.5, useCORS: true, backgroundColor: '#000000' }}, 
                    jsPDF:        {{ unit: 'mm', format: [418, 244], orientation: 'landscape' }}
                }};

                html2pdf().set(opt).from(element).save().then(() => {{
                    document.body.classList.remove('is-exporting');
                }});
            }}
        </script>
    </body>
    </html>"""

    with open("index.html", "w", encoding="utf-8") as f:
        f.write(full_site_html)
    
    if all_alerts:
        with open("email_body.txt", "w", encoding="utf-8") as f:
            f.write("The following changes were detected:\n\n" + "\n\n".join(all_alerts))
    elif os.path.exists("email_body.txt"):
        os.remove("email_body.txt")

if __name__ == "__main__": main()