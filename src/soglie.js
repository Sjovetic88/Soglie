const listaEsiti = [
  "1", "X", "2", "GG", "NG",
  "U05", "O05", "U15", "O15", "U25", "O25", "U35", "O35", "U45", "O45",
  "SG0", "SG1", "SG2", "SG3", "SG4", "SG5", "SG6p"
];

const finestreTemporali = [365, 500, 730, 1000];
const raggiSmussamento = [1, 2, 3];
const penaliGiallo = [4, 6, 8, 10, 12, 14];

function calcolaDateIntervallo() {
  const oggi = new Date();
  const milleGiorniFa = new Date();
  milleGiorniFa.setDate(oggi.getDate() - 1000);

  const pad = (n) => String(n).padStart(2, "0");

  const formattaDB = (d) => {
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
  };

  const formattaDisplay = (d) => {
    return pad(d.getDate()) + "-" + pad(d.getMonth() + 1) + "-" + d.getFullYear();
  };

  return {
    dbOggi: formattaDB(oggi),
    dbInizio: formattaDB(milleGiorniFa),
    dispOggi: formattaDisplay(oggi),
    dispInizio: formattaDisplay(milleGiorniFa)
  };
}

function calcolaDataLimite(giorni) {
  const d = new Date();
  d.setDate(d.getDate() - giorni);
  const anno = d.getFullYear();
  const mese = String(d.getMonth() + 1).padStart(2, "0");
  const giorno = String(d.getDate()).padStart(2, "0");
  return anno + "-" + mese + "-" + giorno;
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
    ).bind(date.dbOggi).first();

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
      ).bind(riga.nazione, riga.campionato, date.dbInizio, date.dbOggi, timestampOra).run();
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

function estraiDatiPartitaPerEsito(p, esito) {
  const g = p.fthg + p.ftag;
  let prob = 0;
  let reale = 0;

  if (esito === "1") {
    prob = p.prob_1;
    reale = (p.fthg > p.ftag) ? 1 : 0;
  } else if (esito === "X") {
    prob = p.prob_X;
    reale = (p.fthg === p.ftag) ? 1 : 0;
  } else if (esito === "2") {
    prob = p.prob_2;
    reale = (p.fthg < p.ftag) ? 1 : 0;
  } else if (esito === "GG") {
    prob = p.prob_gg;
    reale = (p.fthg > 0 && p.ftag > 0) ? 1 : 0;
  } else if (esito === "NG") {
    prob = p.prob_ng;
    reale = (p.fthg === 0 || p.ftag === 0) ? 1 : 0;
  } else if (esito === "U05") {
    prob = p.prob_u05;
    reale = (g < 0.5) ? 1 : 0;
  } else if (esito === "O05") {
    prob = p.prob_o05;
    reale = (g > 0.5) ? 1 : 0;
  } else if (esito === "U15") {
    prob = p.prob_u15;
    reale = (g < 1.5) ? 1 : 0;
  } else if (esito === "O15") {
    prob = p.prob_o15;
    reale = (g > 1.5) ? 1 : 0;
  } else if (esito === "U25") {
    prob = p.prob_u25;
    reale = (g < 2.5) ? 1 : 0;
  } else if (esito === "O25") {
    prob = p.prob_o25;
    reale = (g > 2.5) ? 1 : 0;
  } else if (esito === "U35") {
    prob = p.prob_u35;
    reale = (g < 3.5) ? 1 : 0;
  } else if (esito === "O35") {
    prob = p.prob_o35;
    reale = (g > 3.5) ? 1 : 0;
  } else if (esito === "U45") {
    prob = p.prob_u45;
    reale = (g < 4.5) ? 1 : 0;
  } else if (esito === "O45") {
    prob = p.prob_o45;
    reale = (g > 4.5) ? 1 : 0;
  } else if (esito === "SG0") {
    prob = p.prob_sg0;
    reale = (g === 0) ? 1 : 0;
  } else if (esito === "SG1") {
    prob = p.prob_sg1;
    reale = (g === 1) ? 1 : 0;
  } else if (esito === "SG2") {
    prob = p.prob_sg2;
    reale = (g === 2) ? 1 : 0;
  } else if (esito === "SG3") {
    prob = p.prob_sg3;
    reale = (g === 3) ? 1 : 0;
  } else if (esito === "SG4") {
    prob = p.prob_sg4;
    reale = (g === 4) ? 1 : 0;
  } else if (esito === "SG5") {
    prob = p.prob_sg5;
    reale = (g === 5) ? 1 : 0;
  } else if (esito === "SG6p") {
    prob = p.prob_sg6p;
    reale = (g >= 6) ? 1 : 0;
  }

  return { prob, reale };
}

function calcolaBrierSingoloEsito(partite, esito) {
  let sommaErrori = 0;
  let conteggioValidi = 0;

  for (const p of partite) {
    const dati = estraiDatiPartitaPerEsito(p, esito);
    if (dati.prob !== null && dati.prob !== undefined) {
      const scarto = Math.pow(dati.prob - dati.reale, 2);
      const scartoOpposto = Math.pow((1 - dati.prob) - (1 - dati.reale), 2);
      sommaErrori += (scarto + scartoOpposto);
      conteggioValidi += 1;
    }
  }

  if (conteggioValidi === 0) return 2.0;
  return sommaErrori / conteggioValidi;
}

function ottieniSoglieSpecifiche(esito) {
  if (esito === "U05" || esito === "O05" || esito === "SG0" || esito === "SG5" || esito === "SG6p") {
    return { verde: 0.20, rosso: 0.30 };
  }
  if (esito === "U15" || esito === "O15" || esito === "U45" || esito === "O45" || esito === "SG1" || esito === "SG4") {
    return { verde: 0.35, rosso: 0.45 };
  }
  if (esito === "GG" || esito === "NG" || esito === "U25" || esito === "O25" || esito === "U35" || esito === "O35" || esito === "SG2" || esito === "SG3") {
    return { verde: 0.46, rosso: 0.50 };
  }
  return { verde: 0.48, rosso: 0.55 };
}

function eseguiCalibrazione72Scenari(partite, esito, semaforo) {
  let migliorRendimento = 0.0;
  let miglioreSogliaStandard = 100.0; 
  let migliorePenaleYellow = 14;

  const limitiDateFiltro = {};
  for (const w of finestreTemporali) {
    limitiDateFiltro[w] = calcolaDataLimite(w);
  }

  for (const w of finestreTemporali) {
    const dataLimite = limitiDateFiltro[w];
    const partiteFinestra = [];
    
    for (const p of partite) {
      if (p.date >= dataLimite) {
        partiteFinestra.push(p);
      }
    }

    const totaleFinestra = partiteFinestra.length;
    if (totaleFinestra === 0) continue;

    const precisioniRaw = {};
    for (let t = 42; t <= 83; t++) {
      const sogliaDecimale = t / 100;
      let countSuperati = 0;
      let countVinti = 0;

      for (const p of partiteFinestra) {
        const dati = estraiDatiPartitaPerEsito(p, esito);
        if (dati.prob >= sogliaDecimale) {
          countSuperati += 1;
          if (dati.reale === 1) {
            countVinti += 1;
          }
        }
      }

      if (countSuperati < 15 || countSuperati < (totaleFinestra * 0.15)) {
        precisioniRaw[t] = 0.0;
      } else {
        precisioniRaw[t] = countVinti / countSuperati;
      }
    }

    for (const r of raggiSmussamento) {
      for (const p of penaliGiallo) {
        
        for (let t = 45; t <= 80; t++) {
          let sommaPrecisioniVicinato = 0;
          const diametroVicini = (r * 2) + 1;

          for (let v = (t - r); v <= (t + r); v++) {
            sommaPrecisioniVicinato += (precisioniRaw[v] || 0.0);
          }

          const precisioneSmussata = sommaPrecisioniVicinato / diametroVicini;

          if (precisioneSmussata > migliorRendimento) {
            migliorRendimento = precisioneSmussata;
            miglioreSogliaStandard = t;
            migliorePenaleYellow = p;
          }
        }

      }
    }
  }

  if (migliorRendimento === 0.0) {
    return 100.0; 
  }

  if (semaforo === "VERDE") {
    return miglioreSogliaStandard;
  } else {
    const sogliaCalcolata = miglioreSogliaStandard + migliorePenaleYellow;
    return (sogliaCalcolata > 100) ? 100.0 : sogliaCalcolata;
  }
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

    let sogliaAttiva = 100.0;
    if (semaforo !== "ROSSO") {
      sogliaAttiva = eseguiCalibrazione72Scenari(partite, esito, semaforo);
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

  // API strategica per la validazione automatica del Worker del Weekend
  if (url.pathname === "/api/ottieni-soglia") {
    try {
      const campionato = url.searchParams.get("campionato");
      const esito = url.searchParams.get("esito");

      if (!campionato || !esito) {
        return new Response(JSON.stringify({
          campionato: "",
          esito: "",
          semaforo: "ROSSO",
          soglia_attiva: 100.0,
          avviso: "Parametri di richiesta mancanti. Scommessa bloccata di sicurezza."
        }), {
          headers: { "Content-Type": "application/json" }
        });
      }

      const record = await env.DB_SOGLIE.prepare(
        "SELECT semaforo, soglia_attiva FROM soglie_calcolate WHERE campionato = ? AND esito = ?"
      ).bind(campionato, esito).first();

      if (!record) {
        return new Response(JSON.stringify({
          campionato: campionato,
          esito: esito,
          semaforo: "ROSSO",
          soglia_attiva: 100.0,
          avviso: "Soglia non trovata nel database. Scommessa bloccata di sicurezza."
        }), {
          headers: { "Content-Type": "application/json" }
        });
      }

      return new Response(JSON.stringify({
        campionato: campionato,
        esito: esito,
        semaforo: record.semaforo,
        soglia_attiva: record.soglia_attiva
      }), {
        headers: { "Content-Type": "application/json" }
      });
    } catch (err) {
      return new Response(JSON.stringify({
        campionato: url.searchParams.get("campionato") || "",
        esito: url.searchParams.get("esito") || "",
        semaforo: "ROSSO",
        soglia_attiva: 100.0,
        avviso: "Errore interno durante il recupero: " + err.message + ". Sicurezza applicata."
      }), {
        status: 500,
        headers: { "Content-Type": "application/json" }
      });
    }
  }

  const mappaBandiereDinamica = await ottieniMappaBandiereDinamica(env);

  if (url.pathname === "/api/stato") {
    try {
      // Sincronizzazioni ordinate alfabeticamente
      const elenco = await env.DB_SOGLIE.prepare(
        "SELECT nazione, campionato, data_inizio, data_fine, stato, match_elaborati, stato_soglie FROM sync_stato_campionati ORDER BY campionato ASC"
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
    "body { background-color: #000000; color: #ffffff; font-family: system-ui, -apple-system, sans-serif; margin: 0; padding: 20px 20px 120px 20px; }",
    ".container { max-width: 800px; margin: 0 auto; background-color: #000000; padding: 0; }",
    "h1 { font-size: 26px; text-align: center; font-weight: 800; text-transform: uppercase; letter-spacing: 1px; color: #ffffff; margin-bottom: 5px; }",
    "h1 span { color: #00e5ff; }",
    ".tab-header { display: flex; justify-content: center; gap: 20px; margin-bottom: 24px; border-bottom: 1px solid #1a1a1a; padding-bottom: 10px; }",
    ".tab-button { background: none; border: none; font-size: 14px; font-weight: 700; text-transform: uppercase; color: #666666; padding: 8px 12px; cursor: pointer; transition: color 0.2s; }",
    ".tab-button.active { color: #00e5ff; border-bottom: 2px solid #00e5ff; }",
    ".tab-content { display: none; }",
    ".tab-content.active { display: block; }",
    ".info-box { background-color: #0c0c0c; border: 1px solid #1a1a1a; padding: 12px 16px; margin-bottom: 20px; border-radius: 8px; text-align: center; }",
    ".info-box p { margin: 4px 0; font-size: 13px; color: #888888; }",
    ".info-box p span { color: #00e5ff; font-weight: bold; }",
    ".status-container { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; padding: 12px 16px; border-radius: 8px; background: #0c0c0c; border: 1px solid #1a1a1a; font-size: 14px; font-weight: bold; }",
    ".status-nitro { color: #00e5ff; }",
    ".status-bg { color: #ff9100; }",
    ".progress-container { background-color: #1a1a1a; border-radius: 9999px; height: 6px; width: 100%; margin-bottom: 24px; overflow: hidden; }",
    ".progress-bar { background-color: #00e5ff; height: 100%; width: 0%; transition: width 0.4s ease; }",
    ".riga-card { background-color: #0c0c0c; border: 1px solid #1a1a1a; border-radius: 8px; padding: 16px; margin-bottom: 12px; display: flex; align-items: center; justify-content: space-between; cursor: pointer; transition: background-color 0.15s, border-color 0.15s; }",
    ".riga-card:hover { background-color: #121212; border-color: #2a2a2a; }",
    ".riga-card .info-sinistra { display: flex; flex-direction: column; gap: 4px; }",
    ".riga-card .nome-campionato { font-size: 15px; font-weight: bold; color: #ffffff; display: flex; align-items: center; gap: 8px; }",
    ".riga-card .valore-destra { font-size: 14px; font-weight: bold; color: #00e5ff; display: flex; align-items: center; gap: 12px; }",
    ".badge-stato { font-size: 16px; line-height: 1; }",
    ".griglia-semafori { display: grid; grid-template-columns: repeat(auto-fill, minmax(75px, 1fr)); gap: 8px; margin-top: 12px; padding: 12px; background: #0c0c0c; border: 1px solid #1a1a1a; border-radius: 8px; }",
    ".tassello-esito { padding: 10px 4px; text-align: center; border-radius: 4px; font-size: 12px; font-weight: bold; display: flex; flex-direction: column; gap: 2px; border: 1px solid transparent; }",
    ".tassello-verde { background-color: #061c15; color: #10b981; border-color: #0c4a34; }",
    ".tassello-giallo { background-color: #211504; color: #f59e0b; border-color: #452403; }",
    ".tassello-rosso { background-color: #220808; color: #ef4444; border-color: #4c1111; }",
    ".dettaglio-partite-container { margin-top: 24px; padding: 20px; background-color: #0c0c0c; border: 1px solid #1a1a1a; border-radius: 8px; display: none; }",
    ".dettaglio-partite-container h3 { margin-top: 0; font-size: 18px; color: #ffffff; }",
    ".lista-partite-scroll { max-height: 250px; overflow-y: auto; background: #000000; border: 1px solid #1a1a1a; border-radius: 6px; }",
    ".lista-partite-scroll table { width: 100%; border-collapse: collapse; }",
    ".lista-partite-scroll th, .lista-partite-scroll td { padding: 12px; text-align: left; font-size: 13px; border-bottom: 1px solid #1a1a1a; }",
    ".lista-partite-scroll th { background-color: #0c0c0c; color: #666666; font-weight: bold; }",
    ".lista-partite-scroll td { color: #aaaaaa; }",
    ".console-box { background-color: #0c0c0c; color: #00e5ff; padding: 16px; border-radius: 8px; font-family: monospace; font-size: 12px; height: 100px; overflow-y: auto; margin-top: 20px; border: 1px solid #1a1a1a; }",
    ".bottom-bar { position: fixed; bottom: 0; left: 0; right: 0; background-color: #000000; border-top: 1px solid #1a1a1a; padding: 10px 20px; display: flex; justify-content: space-around; align-items: center; box-shadow: 0 -2px 10px rgba(0,0,0,0.5); z-index: 100; }",
    ".btn { background: none; border: none; cursor: pointer; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 4px; color: #666666; transition: color 0.2s; padding: 4px 8px; min-width: 80px; }",
    ".btn-icon { font-size: 20px; line-height: 1; }",
    ".btn-text { font-size: 10px; font-weight: 800; text-transform: uppercase; letter-spacing: 0.5px; }",
    ".btn-primary { color: #00e5ff; }",
    ".btn-primary:hover { color: #ffffff; }",
    ".btn-primary.active { color: #ef4444; }",
    ".btn-primary.active:hover { color: #ff6b6b; }",
    ".btn-danger { color: #ff9100; }",
    ".btn-danger:hover { color: #ffffff; }",
    ".btn-danger.active { color: #ef4444; }",
    ".btn-danger.active:hover { color: #ff6b6b; }",
    ".btn-reset { color: #666666; }",
    ".btn-reset:hover { color: #ffffff; }",
    "@keyframes pulse { 0% { opacity: 1; } 50% { opacity: 0.5; } 100% { opacity: 1; } }",
    "</style>",
    "</head>",
    "<body>",
    "<div class='container'>",
    "<h1><i style='font-style: italic; font-weight: 800; letter-spacing: 0.5px;'>GOLDBET</i> <span>SOGLIE</span></h1>",
    "<div class='info-box'>",
    "<p>Intervallo dal <span>" + dateAttuali.dispInizio + "</span> al <span>" + dateAttuali.dispOggi + "</span></p>",
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
    "<div id='lista-campionati-partite'>",
    "</div>",
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
    "<div id='lista-campionati-soglie'>",
    "</div>",
    "<div id='pannello-dettaglio-soglie' class='dettaglio-partite-container'>",
    "<h3 id='titolo-dettaglio-soglie'>Esiti, Semafori e Soglie Attive</h3>",
    "<div id='griglia-esiti-soglie' class='griglia-semafori'>",
    "</div>",
    "</div>",
    "</div>",
    "<h3>Log Operazioni</h3>",
    "<div id='console-log' class='console-box'>",
    "<p style='color: #666666; margin: 0;'>Pannello pronto. Scegli un'operazione in fondo per iniziare...</p>",
    "</div>",
    "</div>",
    "<div class='bottom-bar'>",
    "<button id='btn-start' class='btn btn-primary' onclick='toggleSincronizzazione()'><span class='btn-icon'>▶️</span><span class='btn-text'>AVVIA</span></button>",
    "<button id='btn-soglie' class='btn btn-danger' onclick='toggleCalcoloSoglie()'><span class='btn-icon'>🟢🟡🔴</span><span class='btn-text'>SEMAFORI</span></button>",
    "<button id='btn-reset' class='btn btn-reset' onclick='confermaReset()'><span class='btn-icon'>⛔</span><span class='btn-text'>RESET</span></button>",
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
    "  if (tipo === 'info') p.style.color = '#00e5ff';",
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
    "function ottieniStatoFormattato(stato) {",
    "  var s = stato.toUpperCase();",
    "  if (s === 'PENDING') return '⚪';",
    "  if (s === 'COMPLETED') return '🟢';",
    "  if (s === 'PROCESSING') return '🔵';",
    "  return stato;",
    "}",
    "function renderizzaTabellaPartite(dati) {",
    "  var container = document.getElementById('lista-campionati-partite');",
    "  container.innerHTML = '';",
    "  dati.forEach(function(item) {",
    "    var card = document.createElement('div');",
    "    card.className = 'riga-card';",
    "    card.onclick = function() { mostraDettaglioPartite(item.nazione, item.campionato, item.bandiera, item.stato); };",
    "    var infoSinistra = document.createElement('div');",
    "    infoSinistra.className = 'info-sinistra';",
    "    var nomeCamp = document.createElement('div');",
    "    nomeCamp.className = 'nome-campionato';",
    "    nomeCamp.innerHTML = item.bandiera + ' ' + item.campionato;",
    "    infoSinistra.appendChild(nomeCamp);",
    "    var valoreDestra = document.createElement('div');",
    "    valoreDestra.className = 'valore-destra';",
    "    var badge = document.createElement('span');",
    "    badge.className = 'badge-stato';",
    "    badge.textContent = ottieniStatoFormattato(item.stato);",
    "    var matchCount = document.createElement('span');",
    "    matchCount.style.color = '#666666';",
    "    matchCount.style.fontSize = '12px';",
    "    matchCount.textContent = 'Match: ' + (item.match_elaborati || 0);",
    "    valoreDestra.appendChild(badge);",
    "    valoreDestra.appendChild(matchCount);",
    "    card.appendChild(infoSinistra);",
    "    card.appendChild(valoreDestra);",
    "    container.appendChild(card);",
    "  });",
    "}",
    "function renderizzaTabellaSoglie(dati) {",
    "  var container = document.getElementById('lista-campionati-soglie');",
    "  container.innerHTML = '';",
    "  dati.forEach(function(item) {",
    "    var card = document.createElement('div');",
    "    card.className = 'riga-card';",
    "    card.onclick = function() { mostraDettaglioSoglie(item.nazione, item.campionato, item.bandiera, item.stato_soglie); };",
    "    var infoSinistra = document.createElement('div');",
    "    infoSinistra.className = 'info-sinistra';",
    "    var nomeCamp = document.createElement('div');",
    "    nomeCamp.className = 'nome-campionato';",
    "    nomeCamp.innerHTML = item.bandiera + ' ' + item.campionato;",
    "    infoSinistra.appendChild(nomeCamp);",
    "    var valoreDestra = document.createElement('div');",
    "    valoreDestra.className = 'valore-destra';",
    "    var badge = document.createElement('span');",
    "    badge.className = 'badge-stato';",
    "    badge.textContent = ottieniStatoFormattato(item.stato_soglie);",
    "    valoreDestra.appendChild(badge);",
    "    card.appendChild(infoSinistra);",
    "    card.appendChild(valoreDestra);",
    "    container.appendChild(card);",
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
    "  tbody.innerHTML = '<tr><td colspan=4 style=\"text-align:center;color:#666;\">Caricamento in corso...</td></tr>';",
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
    "  titolo.textContent = bandiera + ' Esiti, Semafori e Soglie per ' + campionato;",
    "  griglia.innerHTML = '<div style=\"grid-column: 1/-1; text-align:center;color:#666;\">Caricamento...</div>';",
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
    "        spanBrier.textContent = 'B: ' + s.brier_score.toFixed(3);",
    "        var spanSoglia = document.createElement('span');",
    "        spanSoglia.style.fontSize = '11px';",
    "        spanSoglia.style.fontWeight = 'bold';",
    "        spanSoglia.textContent = 'S: ' + Math.round(s.soglia_attiva) + '%';",
    "        div.appendChild(spanEsito);",
    "        div.appendChild(spanBrier);",
    "        div.appendChild(spanSoglia);",
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
    "    btn.innerHTML = \"<span class='btn-icon'>▶️</span><span class='btn-text'>AVVIA</span>\";",
    "    btn.className = 'btn btn-primary';",
    "    document.getElementById('stato-operazione').textContent = 'In pausa (Manuale)';",
    "    document.getElementById('stato-operazione').className = 'status-bg';",
    "    scriviLog('Sincronizzazione messa in pausa dall\\'utente.', 'info');",
    "  } else {",
    "    nitroAttiva = true;",
    "    calcoloSoglieAttivo = false;",
    "    var btnSoglie = document.getElementById('btn-soglie');",
    "    btnSoglie.innerHTML = \"<span class='btn-icon'>🟢🟡🔴</span><span class='btn-text'>SEMAFORI</span>\";",
    "    btnSoglie.className = 'btn btn-danger';",
    "    btn.innerHTML = \"<span class='btn-icon'>⏸️</span><span class='btn-text'>PAUSA</span>\";",
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
    "    btn.innerHTML = \"<span class='btn-icon'>🟢🟡🔴</span><span class='btn-text'>SEMAFORI</span>\";",
    "    btn.className = 'btn btn-danger';",
    "    document.getElementById('stato-operazione').textContent = 'In pausa (Manuale)';",
    "    document.getElementById('stato-operazione').className = 'status-bg';",
    "    scriviLog('Calcolo soglie messo in pausa dall\\'utente.', 'info');",
    "  } else {",
    "    calcoloSoglieAttivo = true;",
    "    nitroAttiva = false;",
    "    var btnStart = document.getElementById('btn-start');",
    "    btnStart.innerHTML = \"<span class='btn-icon'>▶️</span><span class='btn-text'>AVVIA</span>\";",
    "    btnStart.className = 'btn btn-primary';",
    "    btn.innerHTML = \"<span class='btn-icon'>⏸️</span><span class='btn-text'>PAUSA</span>\";",
    "    btn.className = 'btn btn-danger active';",
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
    "      body: JSON.stringify({ nazione: prossimo.nazione, campionato: prossimo.campionato })",
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
      "        btnStart.innerHTML = \"<span class='btn-icon'>▶️</span><span class='btn-text'>AVVIA</span>\";",
      "        btnStart.className = 'btn btn-primary';",
      "        var btnSoglie = document.getElementById('btn-soglie');",
      "        btnSoglie.style.display = 'inline-block';",
      "        btnSoglie.innerHTML = \"<span class='btn-icon'>🟢🟡🔴</span><span class='btn-text'>SEMAFORI</span>\";",
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