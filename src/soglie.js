const listaEsiti = [
  "1", "X", "2", "GG", "NG",
  "U05", "O05", "U15", "O15", "U25", "O25", "U35", "O35", "U45", "O45",
  "SG0", "SG1", "SG2", "SG3", "SG4", "SG5", "SG6p"
];

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

async function ottieniMappaBandiereDinamica(env) {
  const mappa = {};
  try {
    const regole = await env.DB_ARCHIVIO.prepare(
      "SELECT div, bandiera FROM regole_leghe WHERE bandiera IS NOT NULL"
    ).all();
    if (regole.results) {
      for (const r of regole.results) {
        mappa[r.div] = r.bandiera;
      }
    }
  } catch (err) {
    console.error("Errore recupero bandiere dal DB: " + err.message);
  }
  return mappa;
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
  await env.DB_SOGLIE.prepare("DELETE FROM soglie_calcolate").run();

  const campionatiSorgente = await env.DB_PRONOSTICI.prepare(
    "SELECT DISTINCT nazione, campionato FROM validazione_risultati WHERE nazione IS NOT NULL AND campionato IS NOT NULL"
  ).all();

  if (campionatiSorgente.results && campionatiSorgente.results.length > 0) {
    const timestampOra = new Date().toISOString();
    
    for (const riga of campionatiSorgente.results) {
      await env.DB_SOGLIE.prepare(
        "INSERT INTO sync_stato_campionati (nazione, campionato, data_inizio, data_fine, stato, match_elaborati, ultimo_aggiornamento, stato_soglie) VALUES (?, ?, ?, ?, 'PENDING', 0, ?, 'PENDING')"
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

function calcolaBrierSingoloEsito(partite, esito) {
  let sommaErrori = 0;
  let conteggioValidi = 0;

  for (const p of partite) {
    const g = p.fthg + p.ftag;
    let probabilitaStima = 0;
    let realeVerificato = 0;

    if (esito === "1") {
      probabilitaStima = p.prob_1;
      realeVerificato = (p.fthg > p.ftag) ? 1 : 0;
    } else if (esito === "X") {
      probabilitaStima = p.prob_X;
      realeVerificato = (p.fthg === p.ftag) ? 1 : 0;
    } else if (esito === "2") {
      probabilitaStima = p.prob_2;
      realeVerificato = (p.fthg < p.ftag) ? 1 : 0;
    } else if (esito === "GG") {
      probabilitaStima = p.prob_gg;
      realeVerificato = (p.fthg > 0 && p.ftag > 0) ? 1 : 0;
    } else if (esito === "NG") {
      probabilitaStima = p.prob_ng;
      realeVerificato = (p.fthg === 0 || p.ftag === 0) ? 1 : 0;
    } else if (esito === "U05") {
      probabilitaStima = p.prob_u05;
      realeVerificato = (g < 0.5) ? 1 : 0;
    } else if (esito === "O05") {
      probabilitaStima = p.prob_o05;
      realeVerificato = (g > 0.5) ? 1 : 0;
    } else if (esito === "U15") {
      probabilitaStima = p.prob_u15;
      realeVerificato = (g < 1.5) ? 1 : 0;
    } else if (esito === "O15") {
      probabilitaStima = p.prob_o15;
      realeVerificato = (g > 1.5) ? 1 : 0;
    } else if (esito === "U25") {
      probabilitaStima = p.prob_u25;
      realeVerificato = (g < 2.5) ? 1 : 0;
    } else if (esito === "O25") {
      probabilitaStima = p.prob_o25;
      realeVerificato = (g > 2.5) ? 1 : 0;
    } else if (esito === "U35") {
      probabilitaStima = p.prob_u35;
      realeVerificato = (g < 3.5) ? 1 : 0;
    } else if (esito === "O35") {
      probabilitaStima = p.prob_o35;
      realeVerificato = (g > 3.5) ? 1 : 0;
    } else if (esito === "U45") {
      probabilitaStima = p.prob_u45;
      realeVerificato = (g < 4.5) ? 1 : 0;
    } else if (esito === "O45") {
      probabilitaStima = p.prob_o45;
      realeVerificato = (g > 4.5) ? 1 : 0;
    } else if (esito === "SG0") {
      probabilitaStima = p.prob_sg0;
      realeVerificato = (g === 0) ? 1 : 0;
    } else if (esito === "SG1") {
      probabilitaStima = p.prob_sg1;
      realeVerificato = (g === 1) ? 1 : 0;
    } else if (esito === "SG2") {
      probabilitaStima = p.prob_sg2;
      realeVerificato = (g === 2) ? 1 : 0;
    } else if (esito === "SG3") {
      probabilitaStima = p.prob_sg3;
      realeVerificato = (g === 3) ? 1 : 0;
    } else if (esito === "SG4") {
      probabilitaStima = p.prob_sg4;
      realeVerificato = (g === 4) ? 1 : 0;
    } else if (esito === "SG5") {
      probabilitaStima = p.prob_sg5;
      realeVerificato = (g === 5) ? 1 : 0;
    } else if (esito === "SG6p") {
      probabilitaStima = p.prob_sg6p;
      realeVerificato = (g >= 6) ? 1 : 0;
    } else {
      continue;
    }

    if (probabilitaStima !== null && probabilitaStima !== undefined) {
      const scarto = Math.pow(probabilitaStima - realeVerificato, 2);
      const scartoOpposto = Math.pow((1 - probabilitaStima) - (1 - realeVerificato), 2);
      sommaErrori += (scarto + scartoOpposto);
      conteggioValidi += 1;
    }
  }

  if (conteggioValidi === 0) return 2.0;
  return sommaErrori / conteggioValidi;
}

// Restituisce le soglie specifiche per semaforo in base al tipo di mercato
function ottieniSoglieSpecifiche(esito) {
  // Gruppo 1: Ultra-Sbilanciati (U05, O05, SG0, SG5, SG6p)
  if (esito === "U05" || esito === "O05" || esito === "SG0" || esito === "SG5" || esito === "SG6p") {
    return { verde: 0.20, rosso: 0.30 };
  }
  // Gruppo 2: Altamente Sbilanciati (U15, O15, U45, O45, SG1, SG4)
  if (esito === "U15" || esito === "O15" || esito === "U45" || esito === "O45" || esito === "SG1" || esito === "SG4") {
    return { verde: 0.35, rosso: 0.45 };
  }
  // Gruppo 3: Binari Bilanciati (GG, NG, U25, O25, U35, O35, SG2, SG3)
  if (esito === "GG" || esito === "NG" || esito === "U25" || esito === "O25" || esito === "U35" || esito === "O35" || esito === "SG2" || esito === "SG3") {
    return { verde: 0.46, rosso: 0.50 };
  }
  // Gruppo 4: Multiclasse 1X2 (1, X, 2)
  return { verde: 0.48, rosso: 0.55 };
}

async function elaboraSoglieCampionato(env, nazione, campionato) {
  const queryPartite = await env.DB_SOGLIE.prepare(
    "SELECT * FROM partite_filtrate WHERE nazione = ? AND campionato = ?"
  ).bind(nazione, campionato).all();

  const partite = queryPartite.results || [];
  if (partite.length === 0) return 0;

  const timestampOra = new Date().toISOString();
  const statementSalvaSoglia = env.DB_SOGLIE.prepare(
    "INSERT OR REPLACE INTO soglie_calcolate (nazione, campionato, esito, brier_score, semaforo, soglia_attiva, ultimo_aggiornamento) VALUES (?, ?, ?, ?, ?, ?, ?)"
  );

  const chiamateBatch = [];

  for (const esito of listaEsiti) {
    const brier = calcolaBrierSingoloEsito(partite, esito);
    const limiti = ottieniSoglieSpecifiche(esito);
    let semaforo = "VERDE";

    if (brier >= limiti.rosso) {
      semaforo = "ROSSO";
    } else if (brier >= limiti.verde) {
      semaforo = "GIALLO";
    }

    let sogliaAttiva = 0.0; 
    if (semaforo === "ROSSO") {
      sogliaAttiva = 100.0; // Freno d'emergenza attivo
    }

    chiamateBatch.push(
      statementSalvaSoglia.bind(nazione, campionato, esito, brier, semaforo, sogliaAttiva, timestampOra)
    );
  }

  await env.DB_SOGLIE.batch(chiamateBatch);

  await env.DB_SOGLIE.prepare(
    "UPDATE sync_stato_campionati SET stato_soglie = 'COMPLETED', ultimo_aggiornamento = ? WHERE nazione = ? AND campionato = ?"
  ).bind(timestampOra, nazione, campionato).run();

  return listaEsiti.length;
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

  const mappaBandiereDinamica = await ottieniMappaBandiereDinamica(env);

  if (url.pathname === "/api/stato") {
    try {
      const elenco = await env.DB_SOGLIE.prepare(
        "SELECT nazione, campionato, data_inizio, data_fine, stato, match_elaborati, stato_soglie FROM sync_stato_campionati"
      ).all();

      const campionatiConBandiere = (elenco.results || []).map(item => {
        return {
          nazione: item.nazione,
          campionato: item.campionato,
          data_inizio: item.data_inizio,
          data_fine: item.data_fine,
          stato: item.stato,
          match_elaborati: item.match_elaborati,
          stato_soglie: item.stato_soglie || "PENDING",
          bandiera: mappaBandiereDinamica[item.campionato] || "🏳️"
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

  if (url.pathname === "/api/semafori-salvati") {
    try {
      const campionato = url.searchParams.get("campionato");
      const nazione = url.searchParams.get("nazione");

      const semafori = await env.DB_SOGLIE.prepare(
        "SELECT esito, brier_score, semaforo, soglia_attiva FROM soglie_calcolate WHERE nazione = ? AND campionato = ?"
      ).bind(nazione, campionato).all();

      return new Response(JSON.stringify(semafori.results || []), {
        headers: { "Content-Type": "application/json" }
      });
    } catch (err) {
      return new Response(JSON.stringify({ error: err.message }), {
        status: 500,
        headers: { "Content-Type": "application/json" }
      });
    }
  }

  if (url.pathname === "/api/partite-salvate") {
    try {
      const campionato = url.searchParams.get("campionato");
      const nazione = url.searchParams.get("nazione");

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
      return new Response(JSON.stringify({ success: true, message: "Reset eseguito" }), {
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

  if (url.pathname === "/api/elabora-soglia-singola" && request.method === "POST") {
    try {
      const dati = await request.json();
      const nazione = dati.nazione;
      const campionato = dati.campionato;

      await env.DB_SOGLIE.prepare(
        "UPDATE sync_stato_campionati SET stato_soglie = 'PROCESSING' WHERE nazione = ? AND campionato = ?"
      ).bind(nazione, campionato).run();

      const esitiCalcolati = await elaboraSoglieCampionato(env, nazione, campionato);

      return new Response(JSON.stringify({ success: true, esiti_calcolati: esitiCalcolati }), {
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
    ".tab-header { display: flex; gap: 12px; margin-bottom: 20px; border-bottom: 2px solid #e5e7eb; padding-bottom: 8px; }",
    ".tab-button { background: none; border: none; font-size: 16px; font-weight: bold; color: #6b7280; padding: 8px 16px; cursor: pointer; }",
    ".tab-button.active { color: #3b82f6; border-bottom: 3px solid #3b82f6; }",
    ".tab-content { display: none; }",
    ".tab-content.active { display: block; }",
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
    ".console-box { background-color: #111827; color: #10b981; padding: 16px; border-radius: 6px; font-family: monospace; font-size: 12px; height: 100px; overflow-y: auto; margin-top: 20px; border: 1px solid #374151; }",
    ".bottom-bar { position: fixed; bottom: 0; left: 0; right: 0; background-color: #ffffff; border-top: 1px solid #e5e7eb; padding: 16px 20px; display: flex; justify-content: center; gap: 16px; box-shadow: 0 -2px 10px rgba(0,0,0,0.05); z-index: 100; }",
    ".btn { padding: 10px 20px; font-size: 14px; font-weight: bold; border-radius: 6px; cursor: pointer; border: none; transition: background-color 0.2s; }",
    ".btn-primary { background-color: #3b82f6; color: white; }",
    ".btn-primary:hover { background-color: #2563eb; }",
    ".btn-primary.active { background-color: #ef4444; }",
    ".btn-primary.active:hover { background-color: #dc2626; }",
    ".btn-danger { background-color: #9ca3af; color: white; }",
    ".btn-danger:hover { background-color: #4b5563; }",
    ".griglia-semafori { display: grid; grid-template-columns: repeat(auto-fill, minmax(70px, 1fr)); gap: 8px; margin-top: 12px; padding: 12px; background: #f9fafb; border-radius: 6px; border: 1px solid #e5e7eb; }",
    ".tassello-esito { padding: 8px 4px; text-align: center; border-radius: 4px; font-size: 11px; font-weight: bold; color: white; display: flex; flex-direction: column; gap: 2px; }",
    ".tassello-verde { background-color: #10b981; }",
    ".tassello-giallo { background-color: #f59e0b; }",
    ".tassello-rosso { background-color: #ef4444; }",
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
    "<div class='tab-header'>",
    "<button id='tab-btn-partite' class='tab-button active' onclick='cambiaScheda(\"partite\")'>1. Copia Partite</button>",
    "<button id='tab-btn-soglie' class='tab-button' onclick='cambiaScheda(\"soglie\")'>2. Semafori Soglie</button>",
    "</div>",
    "<div class='status-container'>",
    "<span>Stato Operazione:</span>",
    "<span id='stato-operazione' class='status-bg'>In attesa di avvio manuale</span>",
    "</div>",
    "<div class='progress-container'>",
    "<div id='barra-progresso' class='progress-bar'></div>",
    "</div>",
    "<div id='tab-partite' class='tab-content active'>",
    "<p style='font-size: 13px; color: #6b7280; margin-bottom: 8px;'>💡 Clicca su un campionato completato per visualizzare l'anteprima delle partite filtrate.</p>",
    "<table>",
    "<thead>",
    "<tr>",
    "<th>Campionato</th>",
    "<th>Intervallo Date</th>",
    "<th>Stato</th>",
    "<th>Match Salvati</th>",
    "</tr>",
    "</thead>",
    "<tbody id='tabella-corpo-partite'>",
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
    "</div>",
    "<div id='tab-soglie' class='tab-content'>",
    "<p style='font-size: 13px; color: #6b7280; margin-bottom: 8px;'>💡 Clicca su un campionato per esaminare lo stato di salute di ciascuno dei 22 esiti.</p>",
    "<table>",
    "<thead>",
    "<tr>",
    "<th>Campionato</th>",
    "<th>Stato Sincro</th>",
    "<th>Calcolo Soglie</th>",
    "</tr>",
    "</thead>",
    "<tbody id='tabella-corpo-soglie'>",
    "</tbody>",
    "</table>",
    "<div id='pannello-dettaglio-soglie' class='dettaglio-partite-container'>",
    "<h3 id='titolo-dettaglio-soglie'>Esiti e Semafori</h3>",
    "<div id='griglia-esiti-soglie' class='griglia-semafori'>",
    "</div>",
    "</div>",
    "</div>",
    "<h3>Log Operazioni</h3>",
    "<div id='console-log' class='console-box'>",
    "<p style='color: #9ca3af; margin: 0;'>Pannello pronto. Scegli un'operazione in fondo per iniziare...</p>",
    "</div>",
    "</div>",
    "<div class='bottom-bar'>",
    "<button id='btn-start' class='btn btn-primary' onclick='toggleSincronizzazione()'>Avvia Sincronizzazione</button>",
    "<button id='btn-soglie' class='btn btn-primary' onclick='toggleCalcoloSoglie()'>Calcola Semafori</button>",
    "<button id='btn-reset' class='btn btn-danger' onclick='confermaReset()'>Reset Totale</button>",
    "</div>",
    "<script>",
    "var campionatiInteri = [];",
    "var schedaAttiva = 'partite';",
    "var nitroAttiva = false;",
    "var calcoloSoglieAttivo = false;",
    "var elaborazioneInCorso = false;",
    "var mappaBandiereDinamica = " + JSON.stringify(mappaBandiereDinamica) + ";",
    "function cambiaScheda(nome) {",
    "  schedaAttiva = nome;",
    "  document.querySelectorAll('.tab-button').forEach(function(b) { b.classList.remove('active'); });",
    "  document.querySelectorAll('.tab-content').forEach(function(c) { c.classList.remove('active'); });",
    "  if (nome === 'partite') {",
    "    document.getElementById('tab-btn-partite').classList.add('active');",
    "    document.getElementById('tab-partite').classList.add('active');",
    "  } else {",
    "    document.getElementById('tab-btn-soglie').classList.add('active');",
    "    document.getElementById('tab-soglie').classList.add('active');",
    "  }",
    "  aggiornaBarraProgresso();",
    "}",
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
    "function aggiornaBarraProgresso() {",
    "  if (!campionatiInteri.length) return;",
    "  var completati = 0;",
    "  if (schedaAttiva === 'partite') {",
    "    completati = campionatiInteri.filter(function(item) { return item.stato === 'COMPLETED'; }).length;",
    "  } else {",
    "    completati = campionatiInteri.filter(function(item) { return item.stato_soglie === 'COMPLETED'; }).length;",
    "  }",
    "  var perc = Math.round((completati / campionatiInteri.length) * 100);",
    "  document.getElementById('barra-progresso').style.width = perc + '%';",
    "}",
    "function renderizzaTabellaPartite(dati) {",
    "  var tbody = document.getElementById('tabella-corpo-partite');",
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
    "}",
    "function renderizzaTabellaSoglie(dati) {",
    "  var tbody = document.getElementById('tabella-corpo-soglie');",
    "  tbody.innerHTML = '';",
    "  dati.forEach(function(item) {",
    "    var tr = document.createElement('tr');",
    "    tr.className = 'riga-campionato';",
    "    tr.onclick = function() { mostraDettaglioSoglie(item.nazione, item.campionato, item.bandiera, item.stato_soglie); };",
    "    var tdCamp = document.createElement('td');",
    "    tdCamp.innerHTML = item.bandiera + ' ' + item.campionato;",
    "    var tdSincro = document.createElement('td');",
    "    var badgeSinc = document.createElement('span');",
    "    badgeSinc.className = 'badge badge-' + item.stato.toLowerCase();",
    "    badgeSinc.textContent = item.stato;",
    "    tdSincro.appendChild(badgeSinc);",
    "    var tdSoglie = document.createElement('td');",
    "    var badgeSog = document.createElement('span');",
    "    badgeSog.className = 'badge badge-' + item.stato_soglie.toLowerCase();",
    "    badgeSog.textContent = item.stato_soglie;",
    "    tdSoglie.appendChild(badgeSog);",
    "    tr.appendChild(tdCamp);",
    "    tr.appendChild(tdSincro);",
    "    tr.appendChild(tdSoglie);",
    "    tbody.appendChild(tr);",
    "  });",
    "}",
    "async function mostraDettaglioPartite(nazione, campionato, bandiera, stato) {",
    "  if (stato !== 'COMPLETED') {",
    "    alert('Puoi visualizzare l anteprima solo per i campionati completati.');",
    "    return;",
    "  }",
    "  var pannello = document.getElementById('pannello-dettaglio');",
    "  var titolo = document.getElementById('titolo-dettaglio');",
    "  var tbody = document.getElementById('tabella-partite-dettaglio');",
    "  titolo.textContent = bandiera + ' Partite Filtrate per ' + campionato;",
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
    "    }",
    "  } catch(e) {",
    "    tbody.innerHTML = '<tr><td colspan=4 style=\"text-align:center;color:red;\">Errore di connessione</td></tr>';",
    "  }",
    "}",
    "async function mostraDettaglioSoglie(nazione, campionato, bandiera, stato_soglie) {",
    "  if (stato_soglie !== 'COMPLETED') {",
    "    alert('Semafori non ancora calcolati per questo campionato.');",
    "    return;",
    "  }",
    "  var pannello = document.getElementById('pannello-dettaglio-soglie');",
    "  var titolo = document.getElementById('titolo-dettaglio-soglie');",
    "  var griglia = document.getElementById('griglia-esiti-soglie');",
    "  titolo.textContent = bandiera + ' Esiti e Semafori per ' + campionato;",
    "  griglia.innerHTML = '<div style=\"grid-column: 1/-1; text-align:center;\">Caricamento...</div>';",
    "  pannello.style.display = 'block';",
    "  try {",
    "    var res = await fetch('/api/semafori-salvati?nazione=' + encodeURIComponent(nazione) + '&campionato=' + encodeURIComponent(campionato));",
    "    if (res.ok) {",
    "      var semafori = await res.json();",
    "      griglia.innerHTML = '';",
    "      semafori.forEach(function(s) {",
    "        var div = document.createElement('div');",
    "        var colSemaforo = 'tassello-verde';",
    "        if (s.semaforo === 'GIALLO') colSemaforo = 'tassello-giallo';",
    "        if (s.semaforo === 'ROSSO') colSemaforo = 'tassello-rosso';",
    "        div.className = 'tassello-esito ' + colSemaforo;",
    "        var spanEsito = document.createElement('span');",
    "        spanEsito.style.fontSize = '12px';",
    "        spanEsito.textContent = s.esito;",
    "        var spanBrier = document.createElement('span');",
    "        spanBrier.style.fontSize = '9px';",
    "        spanBrier.style.opacity = '0.9';",
    "        spanBrier.textContent = s.brier_score.toFixed(3);",
    "        div.appendChild(spanEsito);",
    "        div.appendChild(spanBrier);",
    "        griglia.appendChild(div);",
    "      });",
    "    }",
    "  } catch(e) {",
    "    griglia.innerHTML = '<div style=\"grid-column:1/-1;color:red;\">Errore di caricamento</div>';",
    "  }",
    "}",
    "async function aggiornaStato() {",
    "  try {",
    "    var res = await fetch('/api/stato');",
    "    if (res.ok) {",
    "      campionatiInteri = await res.json();",
    "      renderizzaTabellaPartite(campionatiInteri);",
    "      renderizzaTabellaSoglie(campionatiInteri);",
    "      aggiornaBarraProgresso();",
    "      eseguiLoopSincronizzazione();",
    "      eseguiLoopSoglie();",
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
    "    calcoloSoglieAttivo = false;",
    "    document.getElementById('btn-soglie').textContent = 'Calcola Semafori';",
    "    document.getElementById('btn-soglie').className = 'btn btn-primary';",
    "    btn.textContent = 'Sospendi Sincronizzazione';",
    "    btn.className = 'btn btn-primary active';",
    "    document.getElementById('stato-operazione').textContent = 'Modalità Nitro Attiva (Copia Match)';",
    "    document.getElementById('stato-operazione').className = 'status-nitro';",
    "    scriviLog('Inizio copia reale dei dati guidata dal client...', 'info');",
    "    aggiornaStato();",
    "  }",
    "}",
    "function toggleCalcoloSoglie() {",
    "  var btn = document.getElementById('btn-soglie');",
    "  if (calcoloSoglieAttivo) {",
    "    calcoloSoglieAttivo = false;",
    "    btn.textContent = 'Calcola Semafori';",
    "    btn.className = 'btn btn-primary';",
    "    document.getElementById('stato-operazione').textContent = 'In pausa (Manuale)';",
    "    document.getElementById('stato-operazione').className = 'status-bg';",
    "    scriviLog('Calcolo soglie messo in pausa dall\\'utente.', 'info');",
    "  } else {",
    "    calcoloSoglieAttivo = true;",
    "    nitroAttiva = false;",
    "    document.getElementById('btn-start').textContent = 'Avvia Sincronizzazione';",
    "    document.getElementById('btn-start').className = 'btn btn-primary';",
    "    btn.textContent = 'Sospendi Calcolo';",
    "    btn.className = 'btn btn-primary active';",
    "    document.getElementById('stato-operazione').textContent = 'Modalità Nitro Attiva (Calcolo Semafori)';",
    "    document.getElementById('stato-operazione').className = 'status-nitro';",
    "    scriviLog('Inizio calcolo Brier e Semafori per i campionati coperti...', 'info');",
    "    aggiornaStato();",
    "  }",
    "}",
    "async function eseguiLoopSincronizzazione() {",
    "  if (!nitroAttiva || elaborazioneInCorso) return;",
    "  var prossimo = campionatiInteri.find(function(item) { return item.stato === 'PENDING'; });",
    "  if (!prossimo) {",
    "    document.getElementById('stato-operazione').textContent = 'Copia Partite Completata';",
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
    "    }",
    "  } catch(e) {",
    "    scriviLog('Errore copia: ' + e.message, 'error');",
    "  } finally {",
    "    elaborazioneInCorso = false;",
    "    await aggiornaStato();",
    "  }",
    "}",
    "async function eseguiLoopSoglie() {",
    "  if (!calcoloSoglieAttivo || elaborazioneInCorso) return;",
    "  var prossimo = campionatiInteri.find(function(item) {",
    "    return item.stato === 'COMPLETED' && item.stato_soglie === 'PENDING';",
    "  });",
    "  if (!prossimo) {",
    "    document.getElementById('stato-operazione').textContent = 'Calcolo Semafori Completato';",
    "    document.getElementById('stato-operazione').className = 'status-nitro';",
    "    document.getElementById('btn-soglie').style.display = 'none';",
    "    scriviLog('Calcolo dei 22 semafori terminato per tutti i campionati.', 'success');",
    "    return;",
    "  }",
    "  elaborazioneInCorso = true;",
    "  scriviLog('Avvio calcolo 22 semafori per: ' + prossimo.campionato, 'info');",
    "  try {",
    "    var res = await fetch('/api/elabora-soglia-singola', {",
    "      method: 'POST',",
    "      headers: { 'Content-Type': 'application/json' },",
    "      body: JSON.stringify({ nazione: prossimo. nazione, campionato: prossimo.campionato })",
    "    });",
    "    if (res.ok) {",
    "      var ris = await res.json();",
    "      scriviLog('Elaborato ' + prossimo.campionato + ': Calcolati ' + ris.esiti_calcolati + ' esiti. Freno applicato su Rossi.', 'success');",
    "    }",
    "  } catch(e) {",
    "    scriviLog('Errore calcolo: ' + e.message, 'error');",
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
    "        calcoloSoglieAttivo = false;",
    "        var btnStart = document.getElementById('btn-start');",
    "        btnStart.style.display = 'inline-block';",
    "        btnStart.textContent = 'Avvia Sincronizzazione';",
    "        btnStart.className = 'btn btn-primary';",
    "        var btnSoglie = document.getElementById('btn-soglie');",
    "        btnSoglie.style.display = 'inline-block';",
    "        btnSoglie.textContent = 'Calcola Semafori';",
    "        btnSoglie.className = 'btn btn-primary';",
    "        document.getElementById('stato-operazione').textContent = 'In attesa di avvio manuale';",
    "        document.getElementById('stato-operazione').className = 'status-bg';",
    "        document.getElementById('pannello-dettaglio').style.display = 'none';",
    "        document.getElementById('pannello-dettaglio-soglie').style.display = 'none';",
    "        await aggiornaStato();",
    "      }",
    "    } catch(e) {",
    "      scriviLog('Errore reset: ' + e.message, 'error');",
    "    }",
    "  }",
    "}",
    "document.addEventListener('visibilitychange', function() {",
    "  if (document.hidden && (nitroAttiva || calcoloSoglieAttivo)) {",
    "    nitroAttiva = false;",
    "    calcoloSoglieAttivo = false;",
    "    document.getElementById('stato-operazione').textContent = 'Sincronizzazione in Background...';",
    "    document.getElementById('stato-operazione').className = 'status-bg';",
    "    scriviLog('Interfaccia inattiva. Il controllo passa al Background Server.', 'info');",
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

  const prossimoMatch = await env.DB_SOGLIE.prepare(
    "SELECT nazione, campionato FROM sync_stato_campionati WHERE stato = 'PENDING' LIMIT 1"
  ).first();

  if (prossimoMatch) {
    const nazione = prossimoMatch.nazione;
    const campionato = prossimoMatch.campionato;

    await env.DB_SOGLIE.prepare(
      "UPDATE sync_stato_campionati SET stato = 'PROCESSING' WHERE nazione = ? AND campionato = ?"
    ).bind(nazione, campionato).run();

    await elaboraSincronizzazioneCampionato(env, nazione, campionato);
    return;
  }

  const prossimoSemaforo = await env.DB_SOGLIE.prepare(
    "SELECT nazione, campionato FROM sync_stato_campionati WHERE stato = 'COMPLETED' AND stato_soglie = 'PENDING' LIMIT 1"
  ).first();

  if (prossimoSemaforo) {
    const nazione = prossimoSemaforo.nazione;
    const campionato = prossimoSemaforo.campionato;

    await env.DB_SOGLIE.prepare(
      "UPDATE sync_stato_campionati SET stato_soglie = 'PROCESSING' WHERE nazione = ? AND campionato = ?"
    ).bind(nazione, campionato).run();

    await elaboraSoglieCampionato(env, nazione, campionato);
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