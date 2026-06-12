function calcolaDateIntervallo() {
  const oggi = new Date();
  const milleGiorniFa = new Date();
  milleGiorniFa.setDate(oggi.getDate() - 1000);

  const formattaData = (d) => {
    const anno = d.getFullYear();
    const mese = String(d.getMonth() + 1).padStart(2, "0");
    const giorno = String(d.getDate()).padStart(2, "0");
    return anno + "-" + mese + "-" + giorno;
  };

  return {
    oggi: formattaData(oggi),
    inizio: formattaData(milleGiorniFa)
  };
}

async function inizializzaSeNecessario(env, forzaReset) {
  const date = calcolaDateIntervallo();
  
  if (!forzaReset) {
    const controllo = await env.DB_SOGLIE.prepare(
      "SELECT COUNT(*) as totale FROM sync_stato_campionati WHERE data_fine = ?"
    ).bind(date.oggi).first();

    if (controllo && controllo.totale > 0) {
      return;
    }
  }

  await env.DB_SOGLIE.prepare("DELETE FROM sync_stato_campionati").run();
  await env.DB_SOGLIE.prepare("DELETE FROM partite_filtrate").run();

  const campionatiSorgente = await env.DB_PRONOSTICI.prepare(
    "SELECT DISTINCT nazione, campionato FROM validazione_risultati WHERE nazione IS NOT NULL AND campionato IS NOT NULL"
  ).all();

  if (campionatiSorgente.results && campionatiSorgente.results.length > 0) {
    const timestampOra = new Date().toISOString();
    
    for (const riga of campionatiSorgente.results) {
      await env.DB_SOGLIE.prepare(
        "INSERT INTO sync_stato_campionati (nazione, campionato, data_inizio, data_fine, stato, match_elaborati, ultimo_aggiornamento) VALUES (?, ?, ?, ?, 'PENDING', 0, ?)"
      ).bind(riga.nazione, riga.campionato, date.inizio, date.oggi, timestampOra).run();
    }
  }
}

async function copiaPartiteCampionato(env, nazione, campionato, dataInizio, dataFine) {
  const queryPartite = await env.DB_PRONOSTICI.prepare(
    "SELECT * FROM validazione_risultati WHERE nazione = ? AND campionato = ? AND date >= ? AND date <= ?"
  ).bind(nazione, campionato, dataInizio, dataFine).all();

  const partite = queryPartite.results || [];
  if (partite.length === 0) return 0;

  const insertQuery = "INSERT OR REPLACE INTO partite_filtrate (match_id, date, nazione, campionato, home_team, away_team, fthg, ftag, prob_1, prob_X, prob_2, brier_score_1X2, prob_gg, prob_ng, brier_score_ggng, prob_u05, prob_o05, prob_u15, prob_o15, prob_u25, prob_o25, brier_score_uo25, prob_u35, prob_o35, prob_u45, prob_o45, prob_sg0, prob_sg1, prob_sg2, prob_sg3, prob_sg4, prob_sg5, prob_sg6, prob_sg6p, top1_score, top1_prob, top2_score, top2_prob, top3_score, top3_prob, yield, season) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)";

  const statementPreparato = env.DB_SOGLIE.prepare(insertQuery);
  const dimensioneLotto = 50;

  for (let i = 0; i < partite.length; i += dimensioneLotto) {
    const lotto = partite.slice(i, i + dimensioneLotto);
    const chiamateBatch = [];

    for (const p of lotto) {
      chiamateBatch.push(
        statementPreparato.bind(
          p.match_id, p.date, p.nazione, p.campionato, p.home_team, p.away_team,
          p.fthg, p.ftag, p.prob_1, p.prob_X, p.prob_2, p.brier_score_1X2,
          p.prob_gg, p.prob_ng, p.brier_score_ggng, p.prob_u05, p.prob_o05,
          p.prob_u15, p.prob_o15, p.prob_u25, p.prob_o25, p.brier_score_uo25,
          p.prob_u35, p.prob_o35, p.prob_u45, p.prob_o45, p.prob_sg0, p.prob_sg1,
          p.prob_sg2, p.prob_sg3, p.prob_sg4, p.prob_sg5, p.prob_sg6, p.prob_sg6p,
          p.top1_score, p.top1_prob, p.top2_score, p.top2_prob, p.top3_score, p.top3_prob,
          p.yield, p.season
        )
      );
    }
    await env.DB_SOGLIE.batch(chiamateBatch);
  }

  return partite.length;
}

async function elaboraSincronizzazioneCampionato(env, nazione, campionato) {
  const statoCamp = await env.DB_SOGLIE.prepare(
    "SELECT data_inizio, data_fine FROM sync_stato_campionati WHERE nazione = ? AND campionato = ?"
  ).bind(nazione, campionato).first();

  if (!statoCamp) return 0;

  const totaleCopiate = await copiaPartiteCampionato(
    env, nazione, campionato, statoCamp.data_inizio, statoCamp.data_fine
  );

  const timestampOra = new Date().toISOString();

  await env.DB_SOGLIE.prepare(
    "UPDATE sync_stato_campionati SET stato = 'COMPLETED', match_elaborati = ?, ultimo_aggiornamento = ? WHERE nazione = ? AND campionato = ?"
  ).bind(totaleCopiate, timestampOra, nazione, campionato).run();

  return totaleCopiate;
}

async function handleRequest(request, env) {
  const url = new URL(request.url);

  try {
    if (url.pathname !== "/api/reset") {
      await inizializzaSeNecessario(env, false);
    }
  } catch (err) {
    console.error("Errore inizializzazione automatica: " + err.message);
  }

  // API: Stato attuale + Recupero dinamico bandiere da DB_ARCHIVIO regole_leghe
  if (url.pathname === "/api/stato") {
    try {
      const elenco = await env.DB_SOGLIE.prepare(
        "SELECT nazione, campionato, data_inizio, data_fine, stato, match_elaborati FROM sync_stato_campionati"
      ).all();

      const regole = await env.DB_ARCHIVIO.prepare(
        "SELECT div, bandiera FROM regole_leghe WHERE bandiera IS NOT NULL"
      ).all();

      const mappaBandiere = {};
      if (regole.results) {
        for (const r of regole.results) {
          mappaBandiere[r.div] = r.bandiera;
        }
      }

      const campionatiConBandiere = (elenco.results || []).map(item => {
        return {
          nazione: item.nazione,
          campionato: item.campionato,
          data_inizio: item.data_inizio,
          data_fine: item.data_fine,
          stato: item.stato,
          match_elaborati: item.match_elaborati,
          bandiera: mappaBandiere[item.campionato] || "🏳️"
        };
      });

      return new Response(JSON.stringify(campionatiConBandiere), {
        headers: { "Content-Type": "application/json" }
      });
    } catch (err) {
      return new Response(JSON.stringify({ error: err.message }), {
        status: 500,
        headers: { "Content-Type": "application/json" }
      });
    }
  }

  // API: Estrae e restituisce le partite salvate in locale per un campionato
  if (url.pathname === "/api/partite-salvate") {
    try {
      const campionato = url.searchParams.get("campionato");
      const nazione = url.searchParams.get("nazione");

      if (!campionato || !nazione) {
        return new Response(JSON.stringify({ error: "Parametri errati" }), {
          status: 400,
          headers: { "Content-Type": "application/json" }
        });
      }

      const partite = await env.DB_SOGLIE.prepare(
        "SELECT date, home_team, away_team, fthg, ftag, prob_1, prob_X, prob_2 FROM partite_filtrate WHERE nazione = ? AND campionato = ? ORDER BY date DESC"
      ).bind(nazione, campionato).all();

      return new Response(JSON.stringify(partite.results || []), {
        headers: { "Content-Type": "application/json" }
      });
    } catch (err) {
      return new Response(JSON.stringify({ error: err.message }), {
        status: 500,
        headers: { "Content-Type": "application/json" }
      });
    }
  }

  if (url.pathname === "/api/reset" && request.method === "POST") {
    try {
      await inizializzaSeNecessario(env, true);
      return new Response(JSON.stringify({ success: true, message: "Resettato" }), {
        headers: { "Content-Type": "application/json" }
      });
    } catch (err) {
      return new Response(JSON.stringify({ error: err.message }), {
        status: 500,
        headers: { "Content-Type": "application/json" }
      });
    }
  }

  if (url.pathname === "/api/elabora-singolo" && request.method === "POST") {
    try {
      const dati = await request.json();
      const nazione = dati.nazione;
      const campionato = dati.campionato;

      await env.DB_SOGLIE.prepare(
        "UPDATE sync_stato_campionati SET stato = 'PROCESSING' WHERE nazione = ? AND campionato = ?"
      ).bind(nazione, campionato).run();

      const totaleMatch = await elaboraSincronizzazioneCampionato(env, nazione, campionato);

      return new Response(JSON.stringify({ success: true, match_elaborati: totaleMatch }), {
        headers: { "Content-Type": "application/json" }
      });
    } catch (err) {
      return new Response(JSON.stringify({ error: err.message }), {
        status: 500,
        headers: { "Content-Type": "application/json" }
      });
    }
  }

  const dateAttuali = calcolaDateIntervallo();
  
  const htmlComponenti = [
    "<!DOCTYPE html>",
    "<html>",
    "<head>",
    "<meta charset='utf-8'>",
    "<title>Sincronizzazione Campionati</title>",
    "<meta name='viewport' content='width=device-width, initial-scale=1'>",
    "<style>",
    "body { font-family: system-ui, -apple-system, sans-serif; background-color: #f3f4f6; color: #1f2937; margin: 0; padding: 20px 20px 100px 20px; }",
    ".container { max-width: 800px; margin: 0 auto; background: white; padding: 24px; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }",
    "h1 { font-size: 24px; margin-top: 0; color: #111827; }",
    ".info-box { background-color: #eff6ff; border-left: 4px solid #3b82f6; padding: 12px 16px; margin-bottom: 20px; border-radius: 0 4px 4px 0; }",
    ".info-box p { margin: 4px 0; font-size: 14px; }",
    ".status-container { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; padding: 12px; border-radius: 6px; background: #f9fafb; font-weight: bold; }",
    ".status-nitro { color: #10b981; }",
    ".status-bg { color: #f59e0b; }",
    ".progress-container { background-color: #e5e7eb; border-radius: 4px; height: 10px; width: 100%; margin-bottom: 20px; overflow: hidden; }",
    ".progress-bar { background-color: #3b82f6; height: 100%; width: 0%; transition: width 0.4s ease; }",
    "table { width: 100%; border-collapse: collapse; margin-top: 10px; margin-bottom: 20px; }",
    "th, td { text-align: left; padding: 12px; border-bottom: 1px solid #e5e7eb; font-size: 14px; }",
    "th { background-color: #f9fafb; color: #4b5563; }",
    "tr.riga-campionato { cursor: pointer; transition: background-color 0.15s; }",
    "tr.riga-campionato:hover { background-color: #f3f4f6; }",
    ".badge { display: inline-block; padding: 4px 8px; font-size: 11px; font-weight: bold; border-radius: 9999px; text-transform: uppercase; }",
    ".badge-pending { background-color: #e5e7eb; color: #374151; }",
    ".badge-processing { background-color: #dbeafe; color: #1e40af; animation: pulse 1.5s infinite; }",
    ".badge-completed { background-color: #d1fae5; color: #065f46; }",
    ".console-box { background-color: #111827; color: #10b981; padding: 16px; border-radius: 6px; font-family: monospace; font-size: 12px; height: 120px; overflow-y: auto; margin-top: 20px; border: 1px solid #374151; }",
    ".bottom-bar { position: fixed; bottom: 0; left: 0; right: 0; background-color: #ffffff; border-top: 1px solid #e5e7eb; padding: 16px 20px; display: flex; justify-content: center; gap: 16px; box-shadow: 0 -2px 10px rgba(0,0,0,0.05); z-index: 100; }",
    ".btn { padding: 10px 20px; font-size: 14px; font-weight: bold; border-radius: 6px; cursor: pointer; border: none; transition: background-color 0.2s; }",
    ".btn-primary { background-color: #3b82f6; color: white; }",
    ".btn-primary:hover { background-color: #2563eb; }",
    ".btn-primary.active { background-color: #ef4444; }",
    ".btn-primary.active:hover { background-color: #dc2626; }",
    ".btn-danger { background-color: #9ca3af; color: white; }",
    ".btn-danger:hover { background-color: #4b5563; }",
    ".dettaglio-partite-container { margin-top: 24px; padding: 20px; background-color: #f9fafb; border-radius: 8px; border: 1px solid #e5e7eb; display: none; }",
    ".dettaglio-partite-container h3 { margin-top: 0; font-size: 18px; color: #111827; }",
    ".lista-partite-scroll { max-height: 250px; overflow-y: auto; background: white; border: 1px solid #e5e7eb; border-radius: 6px; }",
    "@keyframes pulse { 0% { opacity: 1; } 50% { opacity: 0.5; } 100% { opacity: 1; } }",
    "</style>",
    "</head>",
    "<body>",
    "<div class='container'>",
    "<h1>Sincronizzazione Archivi Sportivi</h1>",
    "<div class='info-box'>",
    "<p><strong>Oggi:</strong> " + dateAttuali.oggi + "</p>",
    "<p><strong>Inizio intervallo (1000 gg fa):</strong> " + dateAttuali.inizio + "</p>",
    "</div>",
    "<div class='status-container'>",
    "<span>Stato Sincronizzazione:</span>",
    "<span id='stato-operazione' class='status-bg'>In attesa di avvio manuale</span>",
    "</div>",
    "<div class='progress-container'>",
    "<div id='barra-progresso' class='progress-bar'></div>",
    "</div>",
    "<p style='font-size: 13px; color: #6b7280; margin-bottom: 8px;'>💡 Clicca su una riga completata per visualizzare l'anteprima delle partite filtrate.</p>",
    "<table>",
    "<thead>",
    "<tr>",
    "<th>Campionato</th>",
    "<th>Intervallo Date</th>",
    "<th>Stato</th>",
    "<th>Match Salvati</th>",
    "</tr>",
    "</thead>",
    "<tbody id='tabella-corpo'>",
    "</tbody>",
    "</table>",
    "<div id='pannello-dettaglio' class='dettaglio-partite-container'>",
    "<h3 id='titolo-dettaglio'>Partite Salvate</h3>",
    "<div class='lista-partite-scroll'>",
    "<table>",
    "<thead>",
    "<tr>",
    "<th>Data</th>",
    "<th>Partita</th>",
    "<th>Ris.</th>",
    "<th>1X2 Prob.</th>",
    "</tr>",
    "</thead>",
    "<tbody id='tabella-partite-dettaglio'>",
    "</tbody>",
    "</table>",
    "</div>",
    "</div>",
    "<h3>Log Operazioni</h3>",
    "<div id='console-log' class='console-box'>",
    "<p style='color: #9ca3af; margin: 0;'>Pannello pronto. Clicca 'Avvia Sincronizzazione' per iniziare la copia dei dati...</p>",
    "</div>",
    "</div>",
    "<div class='bottom-bar'>",
    "<button id='btn-start' class='btn btn-primary' onclick='toggleSincronizzazione()'>Avvia Sincronizzazione</button>",
    "<button id='btn-reset' class='btn btn-danger' onclick='confermaReset()'>Reset Totale</button>",
    "</div>",
    "<script>",
    "var campionatiInteri = [];",
    "var nitroAttiva = false;",
    "var elaborazioneInCorso = false;",
    "function scriviLog(testo, tipo) {",
    "  var consoleBox = document.getElementById('console-log');",
    "  var p = document.createElement('p');",
    "  var ora = new Date().toLocaleTimeString();",
    "  p.textContent = '[' + ora + '] ' + testo;",
    "  p.style.margin = '2px 0';",
    "  if (tipo === 'success') p.style.color = '#10b981';",
    "  if (tipo === 'info') p.style.color = '#3b82f6';",
    "  if (tipo === 'error') p.style.color = '#ef4444';",
    "  consoleBox.appendChild(p);",
    "  consoleBox.scrollTop = consoleBox.scrollHeight;",
    "}",
    "function calcolaPercentuale(dati) {",
    "  if (!dati.length) return 0;",
    "  var completati = dati.filter(function(item) { return item.stato === 'COMPLETED'; }).length;",
    "  return Math.round((completati / dati.length) * 100);",
    "}",
    "function renderizzaTabella(dati) {",
    "  var tbody = document.getElementById('tabella-corpo');",
    "  tbody.innerHTML = '';",
    "  dati.forEach(function(item) {",
    "    var tr = document.createElement('tr');",
    "    tr.className = 'riga-campionato';",
    "    tr.onclick = function() { mostraDettaglioPartite(item.nazione, item.campionato, item.bandiera, item.stato); };",
    "    var tdCamp = document.createElement('td');",
    "    tdCamp.innerHTML = item.bandiera + ' ' + item.campionato;",
    "    var tdDate = document.createElement('td');",
    "    tdDate.textContent = item.data_inizio + ' a ' + item.data_fine;",
    "    var tdStato = document.createElement('td');",
    "    var badge = document.createElement('span');",
    "    badge.className = 'badge badge-' + item.stato.toLowerCase();",
    "    badge.textContent = item.stato;",
    "    tdStato.appendChild(badge);",
    "    var tdMatch = document.createElement('td');",
    "    tdMatch.textContent = item.match_elaborati || 0;",
    "    tr.appendChild(tdCamp);",
    "    tr.appendChild(tdDate);",
    "    tr.appendChild(tdStato);",
    "    tr.appendChild(tdMatch);",
    "    tbody.appendChild(tr);",
    "  });",
    "  var perc = calcolaPercentuale(dati);",
    "  document.getElementById('barra-progresso').style.width = perc + '%';",
    "}",
    "async function mostraDettaglioPartite(nazione, campionato, bandiera, stato) {",
    "  if (stato !== 'COMPLETED') {",
    "    alert('Puoi visualizzare l anteprima solo per i campionati completati.');",
    "    return;",
    "  }",
    "  var pannello = document.getElementById('pannello-dettaglio');",
    "  var titolo = document.getElementById('titolo-dettaglio');",
    "  var tbody = document.getElementById('tabella-partite-dettaglio');",
    "  titolo.textContent = bandiera + ' Partite Salvate per ' + campionato;",
    "  tbody.innerHTML = '<tr><td colspan=4 style=\"text-align:center;\">Caricamento in corso...</td></tr>';",
    "  pannello.style.display = 'block';",
    "  try {",
    "    var res = await fetch('/api/partite-salvate?nazione=' + encodeURIComponent(nazione) + '&campionato=' + encodeURIComponent(campionato));",
    "    if (res.ok) {",
    "      var partite = await res.json();",
    "      tbody.innerHTML = '';",
    "      if (partite.length === 0) {",
    "        tbody.innerHTML = '<tr><td colspan=4 style=\"text-align:center;\">Nessuna partita copiata</td></tr>';",
    "        return;",
    "      }",
    "      partite.forEach(function(p) {",
    "        var tr = document.createElement('tr');",
    "        var tdData = document.createElement('td');",
    "        tdData.textContent = p.date;",
    "        var tdPartita = document.createElement('td');",
    "        tdPartita.innerHTML = '<b>' + p.home_team + '</b> - ' + p.away_team;",
    "        var tdRis = document.createElement('td');",
    "        tdRis.textContent = p.fthg + '-' + p.ftag;",
    "        var tdProb = document.createElement('td');",
    "        tdProb.textContent = Math.round(p.prob_1 * 100) + '% / ' + Math.round(p.prob_X * 100) + '% / ' + Math.round(p.prob_2 * 100) + '%';",
    "        tr.appendChild(tdData);",
    "        tr.appendChild(tdPartita);",
    "        tr.appendChild(tdRis);",
    "        tr.appendChild(tdProb);",
    "        tbody.appendChild(tr);",
    "      });",
    "    } else {",
    "      tbody.innerHTML = '<tr><td colspan=4 style=\"text-align:center;color:red;\">Errore nel caricamento delle partite</td></tr>';",
    "    }",
    "  } catch(e) {",
    "    tbody.innerHTML = '<tr><td colspan=4 style=\"text-align:center;color:red;\">Errore di connessione</td></tr>';",
    "  }",
    "}",
    "async function aggiornaStato() {",
    "  try {",
    "    var res = await fetch('/api/stato');",
    "    if (res.ok) {",
    "      campionatiInteri = await res.json();",
    "      renderizzaTabella(campionatiInteri);",
    "      eseguiLoopSincronizzazione();",
    "    }",
    "  } catch(e) {",
    "    scriviLog('Errore di connessione API: ' + e.message, 'error');",
    "  }",
    "}",
    "function toggleSincronizzazione() {",
    "  var btn = document.getElementById('btn-start');",
    "  if (nitroAttiva) {",
    "    nitroAttiva = false;",
    "    btn.textContent = 'Avvia Sincronizzazione';",
    "    btn.className = 'btn btn-primary';",
    "    document.getElementById('stato-operazione').textContent = 'In pausa (Manuale)';",
    "    document.getElementById('stato-operazione').className = 'status-bg';",
    "    scriviLog('Sincronizzazione messa in pausa dall\\'utente.', 'info');",
    "  } else {",
    "    nitroAttiva = true;",
    "    btn.textContent = 'Sospendi Sincronizzazione';",
    "    btn.className = 'btn btn-primary active';",
    "    document.getElementById('stato-operazione').textContent = 'Modalità Nitro Attiva';",
    "    document.getElementById('stato-operazione').className = 'status-nitro';",
    "    scriviLog('Inizio copia reale dei dati guidata dal client...', 'info');",
    "    aggiornaStato();",
    "  }",
    "}",
    "async function eseguiLoopSincronizzazione() {",
    "  if (!nitroAttiva || elaborazioneInCorso) return;",
    "  var prossimo = campionatiInteri.find(function(item) { return item.stato === 'PENDING'; });",
    "  if (!prossimo) {",
    "    document.getElementById('stato-operazione').textContent = 'Sincronizzazione Giornaliera Completata';",
    "    document.getElementById('stato-operazione').className = 'status-nitro';",
    "    document.getElementById('btn-start').style.display = 'none';",
    "    scriviLog('Estrazione e copia dei dati storici terminata con successo.', 'success');",
    "    return;",
    "  }",
    "  elaborazioneInCorso = true;",
    "  scriviLog('Copia dati storici per: ' + prossimo.campionato, 'info');",
    "  try {",
    "    var res = await fetch('/api/elabora-singolo', {",
    "      method: 'POST',",
    "      headers: { 'Content-Type': 'application/json' },",
    "      body: JSON.stringify({ nazione: prossimo.nazione, campionato: prossimo.campionato })",
    "    });",
    "    if (res.ok) {",
    "      var ris = await res.json();",
    "      scriviLog('Salvate fisicamente ' + ris.match_elaborati + ' partite per ' + prossimo.campionato, 'success');",
    "    } else {",
    "      scriviLog('Errore durante la copia dati di ' + prossimo.campionato, 'error');",
    "    }",
    "  } catch(e) {",
    "    scriviLog('Errore di rete: ' + e.message, 'error');",
    "  } finally {",
    "    elaborazioneInCorso = false;",
    "    await aggiornaStato();",
    "  }",
    "}",
    "async function confermaReset() {",
    "  if (confirm('Sei sicuro di voler resettare? Tutte le partite salvate e lo stato verranno azzerati.')) {",
    "    scriviLog('Richiesta di svuotamento e ripristino database inviata...', 'info');",
    "    try {",
    "      var res = await fetch('/api/reset', { method: 'POST' });",
    "      if (res.ok) {",
    "        scriviLog('Database ripulito e resettato con successo.', 'success');",
    "        nitroAttiva = false;",
    "        var btn = document.getElementById('btn-start');",
    "        btn.style.display = 'inline-block';",
    "        btn.textContent = 'Avvia Sincronizzazione';",
    "        btn.className = 'btn btn-primary';",
    "        document.getElementById('stato-operazione').textContent = 'In attesa di avvio manuale';",
    "        document.getElementById('stato-operazione').className = 'status-bg';",
    "        document.getElementById('pannello-dettaglio').style.display = 'none';",
    "        await aggiornaStato();",
    "      } else {",
    "        scriviLog('Errore durante la richiesta di reset.', 'error');",
    "      }",
    "    } catch(e) {",
    "      scriviLog('Errore connessione reset: ' + e.message, 'error');",
    "    }",
    "  }",
    "}",
    "document.addEventListener('visibilitychange', function() {",
    "  if (document.hidden && nitroAttiva) {",
    "    nitroAttiva = false;",
    "    document.getElementById('stato-operazione').textContent = 'Sincronizzazione in Background...';",
    "    document.getElementById('stato-operazione').className = 'status-bg';",
    "    scriviLog('Interfaccia inattiva. Il controllo della copia dati passa al Background Server.', 'info');",
    "  } else if (!document.hidden && !nitroAttiva && document.getElementById('btn-start').style.display !== 'none') {",
    "    scriviLog('Pannello riattivato. Premi nuovamente Avvia per riprendere la copia dati.', 'info');",
    "  }",
    "});",
    "aggiornaStato();",
    "</script>",
    "</body>",
    "</html>"
  ];

  const htmlCorpoUnito = htmlComponenti.join(String.fromCharCode(10));
  return new Response(htmlCorpoUnito, {
    headers: { "Content-Type": "text/html; charset=utf-8" }
  });
}

async function handleScheduled(event, env) {
  await inizializzaSeNecessario(env, false);

  const prossimoCampionato = await env.DB_SOGLIE.prepare(
    "SELECT nazione, campionato FROM sync_stato_campionati WHERE stato = 'PENDING' LIMIT 1"
  ).first();

  if (prossimoCampionato) {
    const nazione = prossimoCampionato.nazione;
    const campionato = prossimoCampionato.campionato;

    await env.DB_SOGLIE.prepare(
      "UPDATE sync_stato_campionati SET stato = 'PROCESSING' WHERE nazione = ? AND campionato = ?"
    ).bind(nazione, campionato).run();

    await elaboraSincronizzazioneCampionato(env, nazione, campionato);
  }
}

export default {
  async fetch(request, env, ctx) {
    return handleRequest(request, env);
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(handleScheduled(event, env));
  }
};