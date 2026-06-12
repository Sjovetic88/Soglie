// Dizionario per mappare i nomi delle nazioni alle relative bandiere emoji
const bandiereNazioni = {
  "italy": "🇮🇹",
  "italia": "🇮🇹",
  "england": "🏴󠁧󠁢󠁥󠁮󠁧󠁿",
  "inghilterra": "🏴󠁧󠁢󠁥󠁮󠁧󠁿",
  "spain": "🇪🇸",
  "spagna": "🇪🇸",
  "germany": "🇩🇪",
  "germania": "🇩🇪",
  "france": "🇫🇷",
  "francia": "🇫🇷",
  "netherlands": "🇳🇱",
  "olanda": "🇳🇱",
  "belgium": "🇧🇪",
  "belgio": "🇧🇪",
  "portugal": "🇵🇹",
  "portogallo": "🇵🇹",
  "turkey": "🇹🇷",
  "turchia": "🇹🇷",
  "greece": "🇬🇷",
  "grecia": "🇬🇷",
  "scotland": "🏴󠁧󠁢󠁳󠁣󠁴󠁿",
  "scozia": "🏴󠁧󠁢󠁳󠁣󠁴󠁿"
};

// Funzione helper per ottenere l'emoji della bandiera
function ottieniBandiera(nazione) {
  if (!nazione) return "🏳️";
  const nazioneLower = nazione.toLowerCase();
  return bandiereNazioni[nazioneLower] || "🏳️";
}

// Funzione helper per calcolare le date (Oggi e 1000 giorni fa)
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

// Logica per rilevare automaticamente i campionati dal DB sorgente e inserirli in quello di destinazione
async function inizializzaSeNecessario(env) {
  const date = calcolaDateIntervallo();
  
  // Verifichiamo se ci sono già record per la giornata di oggi
  const controllo = await env.DB_SOGLIE.prepare(
    "SELECT COUNT(*) as totale FROM sync_stato_campionati WHERE data_fine = ?"
  ).bind(date.oggi).first();

  if (controllo && controllo.totale > 0) {
    return; // Sincronizzazione odierna già configurata
  }

  // Eliminiamo i vecchi stati di sincronizzazione precedenti
  await env.DB_SOGLIE.prepare("DELETE FROM sync_stato_campionati").run();

  // Estraiamo tutti i campionati unici dal database dei pronostici
  const campionatiSorgente = await env.DB_PRONOSTICI.prepare(
    "SELECT DISTINCT nazione, campionato FROM validazione_risultati WHERE nazione IS NOT NULL AND campionato IS NOT NULL"
  ).all();

  if (campionatiSorgente.results && campionatiSorgente.results.length > 0) {
    const timestampOra = new Date().toISOString();
    
    // Inseriamo i campionati trovati nel database di stato impostandoli come PENDING
    for (const riga of campionatiSorgente.results) {
      await env.DB_SOGLIE.prepare(
        "INSERT INTO sync_stato_campionati (nazione, campionato, data_inizio, data_fine, stato, match_elaborati, ultimo_aggiornamento) VALUES (?, ?, ?, ?, 'PENDING', 0, ?)"
      ).bind(riga.nazione, riga.campionato, date.inizio, date.oggi, timestampOra).run();
    }
  }
}

// Elabora le partite di un singolo campionato specifico
async function elaboraSincronizzazioneCampionato(env, nazione, campionato) {
  const statoCamp = await env.DB_SOGLIE.prepare(
    "SELECT data_inizio, data_fine FROM sync_stato_campionati WHERE nazione = ? AND campionato = ?"
  ).bind(nazione, campionato).first();

  if (!statoCamp) return 0;

  // Conta e simula l'estrazione delle partite comprese nell'intervallo temporale
  const conteggioMatch = await env.DB_PRONOSTICI.prepare(
    "SELECT COUNT(*) as totale FROM validazione_risultati WHERE nazione = ? AND campionato = ? AND date >= ? AND date <= ?"
  ).bind(nazione, campionato, statoCamp.data_inizio, statoCamp.data_fine).first();

  const totalePartite = conteggioMatch ? conteggioMatch.totale : 0;
  const timestampOra = new Date().toISOString();

  // Aggiorna lo stato nel database di destinazione
  await env.DB_SOGLIE.prepare(
    "UPDATE sync_stato_campionati SET stato = 'COMPLETED', match_elaborati = ?, ultimo_aggiornamento = ? WHERE nazione = ? AND campionato = ?"
  ).bind(totalePartite, timestampOra, nazione, campionato).run();

  return totalePartite;
}

// Handler principale delle richieste HTTP (Dashboard e API)
async function handleRequest(request, env) {
  const url = new URL(request.url);

  // Forza l'inizializzazione automatica per assicurare che il database non sia mai vuoto
  try {
    await inizializzaSeNecessario(env);
  } catch (err) {
    // Continua l'esecuzione anche se l'inizializzazione fallisce, restituendo l'errore in console
    console.error("Errore inizializzazione: " + err.message);
  }

  // API: Restituisce lo stato attuale della sincronizzazione in JSON
  if (url.pathname === "/api/stato") {
    try {
      const elenco = await env.DB_SOGLIE.prepare(
        "SELECT nazione, campionato, data_inizio, data_fine, stato, match_elaborati FROM sync_stato_campionati"
      ).all();
      return new Response(JSON.stringify(elenco.results || []), {
        headers: { "Content-Type": "application/json" }
      });
    } catch (err) {
      return new Response(JSON.stringify({ error: err.message }), {
        status: 500,
        headers: { "Content-Type": "application/json" }
      });
    }
  }

  // API: Elabora un singolo campionato in modalità Nitro o sincrona
  if (url.pathname === "/api/elabora-singolo" && request.method === "POST") {
    try {
      const dati = await request.json();
      const nazione = dati.nazione;
      const campionato = dati.campionato;

      if (!nazione || !campionato) {
        return new Response(JSON.stringify({ error: "Dati mancanti" }), {
          status: 400,
          headers: { "Content-Type": "application/json" }
        });
      }

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

  // Interfaccia HTML della Dashboard (Nessun backtick e nessuna barra rovesciata nel codice JS client o server)
  const dateAttuali = calcolaDateIntervallo();
  
  const htmlComponenti = [
    "<!DOCTYPE html>",
    "<html>",
    "<head>",
    "<meta charset='utf-8'>",
    "<title>Sincronizzazione Campionati</title>",
    "<meta name='viewport' content='width=device-width, initial-scale=1'>",
    "<style>",
    "body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #f3f4f6; color: #1f2937; margin: 0; padding: 20px; }",
    ".container { max-width: 800px; margin: 0 auto; background: white; padding: 24px; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }",
    "h1 { font-size: 24px; margin-top: 0; color: #111827; }",
    ".info-box { background-color: #eff6ff; border-left: 4px solid #3b82f6; padding: 12px 16px; margin-bottom: 20px; border-radius: 0 4px 4px 0; }",
    ".info-box p { margin: 4px 0; font-size: 14px; }",
    ".status-container { display: flex; align-items: center; justify-content: space-between; margin-bottom: 20px; padding: 12px; border-radius: 6px; background: #f9fafb; font-weight: bold; }",
    ".status-nitro { color: #10b981; }",
    ".status-bg { color: #f59e0b; }",
    "table { width: 100%; border-collapse: collapse; margin-top: 10px; }",
    "th, td { text-align: left; padding: 12px; border-bottom: 1px solid #e5e7eb; font-size: 14px; }",
    "th { background-color: #f9fafb; color: #4b5563; }",
    ".badge { display: inline-block; padding: 4px 8px; font-size: 11px; font-weight: bold; border-radius: 9999px; text-transform: uppercase; }",
    ".badge-pending { background-color: #e5e7eb; color: #374151; }",
    ".badge-processing { background-color: #dbeafe; color: #1e40af; animation: pulse 1.5s infinite; }",
    ".badge-completed { background-color: #d1fae5; color: #065f46; }",
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
    "<span id='stato-operazione' class='status-nitro'>Verifica stato in corso...</span>",
    "</div>",
    "<table>",
    "<thead>",
    "<tr>",
    "<th>Campionato</th>",
    "<th>Intervallo Date</th>",
    "<th>Stato</th>",
    "<th>Match Estratti</th>",
    "</tr>",
    "</thead>",
    "<tbody id='tabella-corpo'>",
    "</tbody>",
    "</table>",
    "</div>",
    "<script>",
    "var campionatiInteri = [];",
    "var nitroAttiva = true;",
    "var elaborazioneInCorso = false;",
    "var mappaBandiere = " + JSON.stringify(bandiereNazioni) + ";",
    "function ottieniBandieraClient(nazione) {",
    "  if (!nazione) return '🏳️';",
    "  var n = nazione.toLowerCase();",
    "  return mappaBandiere[n] || '🏳️';",
    "}",
    "function renderizzaTabella(dati) {",
    "  var tbody = document.getElementById('tabella-corpo');",
    "  tbody.innerHTML = '';",
    "  dati.forEach(function(item) {",
    "    var tr = document.createElement('tr');",
    "    var tdCamp = document.createElement('td');",
    "    tdCamp.innerHTML = ottieniBandieraClient(item.nazione) + ' ' + item.campionato;",
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
    "    console.error('Errore aggiornamento:', e);",
    "  }",
    "}",
    "async function eseguiLoopSincronizzazione() {",
    "  if (!nitroAttiva || elaborazioneInCorso) return;",
    "  var prossimo = campionatiInteri.find(function(item) { return item.stato === 'PENDING'; });",
    "  if (!prossimo) {",
    "    document.getElementById('stato-operazione').textContent = 'Sincronizzazione Giornaliera Completata';",
    "    document.getElementById('stato-operazione').className = 'status-nitro';",
    "    return;",
    "  }",
    "  elaborazioneInCorso = true;",
    "  document.getElementById('stato-operazione').textContent = 'Modalità Nitro: Elaborazione ' + prossimo.campionato + '...';",
    "  document.getElementById('stato-operazione').className = 'status-nitro';",
    "  try {",
    "    var res = await fetch('/api/elabora-singolo', {",
    "      method: 'POST',",
    "      headers: { 'Content-Type': 'application/json' },",
    "      body: JSON.stringify({ nazione: prossimo.nazione, campionato: prossimo.campionato })",
    "    });",
    "    if (res.ok) {",
    "      await aggiornaStato();",
    "    }",
    "  } catch(e) {",
    "    console.error('Errore durante elaborazione:', e);",
    "  } finally {",
    "    elaborazioneInCorso = false;",
    "  }",
    "}",
    "document.addEventListener('visibilitychange', function() {",
    "  if (document.hidden) {",
    "    nitroAttiva = false;",
    "    document.getElementById('stato-operazione').textContent = 'Sincronizzazione in Background...';",
    "    document.getElementById('stato-operazione').className = 'status-bg';",
    "  } else {",
    "    nitroAttiva = true;",
    "    aggiornaStato();",
    "  }",
    "});",
    "setInterval(aggiornaStato, 5000);",
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

// Handler per l'esecuzione pianificata a Mezzanotte (Cron Trigger)
async function handleScheduled(event, env) {
  // Inizializza automaticamente i campionati per la nuova giornata azzerando la tabella di stato
  await inizializzaSeNecessario(env);

  // Trova il primo campionato in PENDING ed elaboralo per dare inizio al processo in background
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

// Esporta le due interfacce di esecuzione del Worker Cloudflare
export default {
  async fetch(request, env, ctx) {
    return handleRequest(request, env);
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(handleScheduled(event, env));
  }
};