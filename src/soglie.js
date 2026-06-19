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
    const recordUltimo = await env.DB_SOGLIE.prepare(
      "SELECT ultimo_aggiornamento FROM sync_stato_campionati ORDER BY ultimo_aggiornamento ASC LIMIT 1"
    ).first();

    if (recordUltimo && recordUltimo.ultimo_aggiornamento) {
      const oraUltimo = new Date(recordUltimo.ultimo_aggiornamento).getTime();
      const oraOra = new Date().getTime();
      const differenzaOre = (oraOra - oraUltimo) / (1000 * 60 * 60);

      if (differenzaOre < 6.0) {
        return;
      }
    } else if (recordUltimo) {
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
        "INSERT INTO sync_stato_campionati (nazione, campionato, data_inizio, data_fine, stato, match_elaborati, ultimo_aggiornamento, stato_semafori, stato_soglie) VALUES (?, ?, ?, ?, 'PENDING', 0, NULL, 'PENDING', 'PENDING')"
      ).bind(riga.nazione, riga.campionato, date.dbInizio, date.dbOggi).run();
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
    "UPDATE sync_stato_campionati SET stato_semafori = 'COMPLETED', stato_soglie = 'COMPLETED', ultimo_aggiornamento = ? WHERE nazione = ? AND campionato = ?"
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

  // API speciale di aggancio per bypassare i Cron di Cloudflare tramite Cron-Job.org (Sicurezza attiva)
  if (url.pathname === "/api/cron-background") {
    const key = url.searchParams.get("key");
    if (key !== "sogliesecret123") {
      return new Response("Non autorizzato", { status: 403 });
    }
    try {
      await handleScheduled(null, env);
      return new Response("OK - Cron eseguito con successo in background", {
        headers: { "Content-Type": "text/plain; charset=utf-8" }
      });
    } catch (err) {
      return new Response("Errore di background: " + err.message, {
        status: 500,
        headers: { "Content-Type": "text/plain; charset=utf-8" }
      });
    }
  }

  const mappaBandiereDinamica = await ottieniMappaBandiereDinamica(env);

  if (url.pathname === "/api/stato") {
    try {
      const elenco = await env.DB_SOGLIE.prepare(
        "SELECT nazione, campionato, data_inizio, data_fine, stato, match_elaborati, stato_semafori, stato_soglie FROM sync_stato_campionati ORDER BY campionato ASC"
      ).all();

      const campionatiConBandiere = (elenco.results || []).map(item => {
        return {
          nazione: item.nazione,
          campionato: item.campionato,
          data_inizio: item.data_inizio,
          data_fine: item.data_fine,
          stato: item.stato,
          match_elaborati: item.match_elaborati,
          stato_semafori: item.stato_semafori || "PENDING",
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

  if (url.pathname === "/api/semafori-tutti") {
    try {
      const semafori = await env.DB_SOGLIE.prepare(
        "SELECT nazione, campionato, esito, semaforo, soglia_attiva FROM soglie_calcolate"
      ).all();
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
        "SELECT date, home_team, away_team, fthg, ftag, prob_1, prob_X, prob_2, prob_gg, prob_ng, prob_u05, prob_o05, prob_u15, prob_o15, prob_u25, prob_o25, prob_u35, prob_o35, prob_u45, prob_o45, prob_sg0, prob_sg1, prob_sg2, prob_sg3, prob_sg4, prob_sg5, prob_sg6p FROM partite_filtrate WHERE nazione = ? AND campionato = ? ORDER BY date DESC"
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
        "UPDATE sync_stato_campionati SET stato_semafori = 'PROCESSING', stato_soglie = 'PROCESSING' WHERE nazione = ? AND campionato = ?"
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
    ".info-box { background-color: #0c0c0c; border: 1px solid #1a1a1a; padding: 12px 16px; margin-bottom: 24px; border-radius: 8px; text-align: center; }",
    ".info-box p { margin: 4px 0; font-size: 13px; color: #888888; }",
    ".info-box p span { color: #00e5ff; font-weight: bold; }",
    ".tab-content { display: none; }",
    ".tab-content.active { display: block; }",
    ".status-container { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; padding: 12px 16px; border-radius: 8px; background: #0c0c0c; border: 1px solid #1a1a1a; font-size: 14px; font-weight: bold; }",
    ".status-nitro { color: #00e5ff; }",
    ".status-bg { color: #ff9100; }",
    ".progress-container { background-color: #1a1a1a; border-radius: 9999px; height: 6px; width: 100%; margin-bottom: 24px; overflow: hidden; }",
    ".progress-bar { background-color: #00e5ff; height: 100%; width: 0%; transition: width 0.4s ease; }",
    ".riga-card { background-color: #0c0c0c; border: 1px solid #1a1a1a; border-radius: 8px; padding: 12px 16px; margin-bottom: 10px; display: grid; grid-template-columns: 120px 100px 1fr; align-items: center; cursor: pointer; transition: background-color 0.15s, border-color 0.15s; }",
    ".riga-card:hover { background-color: #121212; border-color: #2a2a2a; }",
    ".riga-card .nome-campionato { font-size: 15px; font-weight: bold; color: #ffffff; display: flex; align-items: center; gap: 8px; }",
    ".riga-card .valore-centrale { display: flex; justify-content: center; gap: 8px; }",
    ".riga-card .valore-destra { text-align: right; font-size: 12px; color: #666666; font-weight: bold; }",
    ".badge-stato { font-size: 16px; line-height: 1; display: inline-block; width: 22px; text-align: center; }",
    ".dettaglio-partite-container { margin-top: 10px; padding: 20px; background-color: #0c0c0c; border: 1px solid #1a1a1a; border-radius: 8px; }",
    ".dettaglio-partite-container h3 { margin-top: 0; font-size: 18px; color: #ffffff; text-align: center; border-bottom: 1px solid #1a1a1a; padding-bottom: 10px; }",
    ".btn-indietro { display: inline-block; background-color: #1a1a1a; border: 1px solid #333333; color: #ffffff; padding: 8px 16px; border-radius: 6px; font-size: 12px; font-weight: bold; cursor: pointer; transition: background-color 0.2s; margin-bottom: 15px; }",
    ".btn-indietro:hover { background-color: #2a2a2a; }",
    ".lista-partite-scroll { max-height: 450px; overflow-y: auto; overflow-x: auto; background: #000000; border: 1px solid #1a1a1a; border-radius: 6px; margin-top: 15px; }",
    ".lista-partite-scroll table { width: 100%; border-collapse: collapse; white-space: nowrap; }",
    ".lista-partite-scroll th, .lista-partite-scroll td { padding: 10px 14px; text-align: center; font-size: 13px; border-bottom: 1px solid #1a1a1a; }",
    ".lista-partite-scroll th { background-color: #0c0c0c; color: #666666; font-weight: bold; }",
    ".lista-partite-scroll td { color: #aaaaaa; }",
    ".lista-partite-scroll td b { color: #ffffff; }",
    ".console-box { background-color: #0c0c0c; color: #00e5ff; padding: 16px; border-radius: 8px; font-family: monospace; font-size: 12px; height: 150px; overflow-y: auto; margin-top: 20px; border: 1px solid #1a1a1a; }",
    ".bottom-bar { position: fixed; bottom: 0; left: 0; right: 0; background-color: #000000; border-top: 1px solid #1a1a1a; padding: 10px 10px; display: flex; justify-content: space-around; align-items: center; box-shadow: 0 -2px 10px rgba(0,0,0,0.5); z-index: 100; }",
    ".btn { background: none; border: none; cursor: pointer; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 4px; color: #666666; transition: color 0.2s; padding: 4px 6px; min-width: 65px; }",
    ".btn-icon { font-size: 20px; line-height: 1; }",
    ".btn-text { font-size: 9px; font-weight: 800; text-transform: uppercase; letter-spacing: 0.5px; }",
    ".btn-tab { color: #555555; }",
    ".btn-tab.active { color: #00e5ff; }",
    ".btn-primary { color: #00e5ff; }",
    ".btn-primary:hover { color: #ffffff; }",
    ".btn-primary.active { color: #ef4444; }",
    ".btn-primary.active:hover { color: #ff6b6b; }",
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
    "<div id='tab-view-match' class='tab-content active'>",
    "<div id='lista-partite-campionati'></div>",
    "<div id='pannello-dettaglio-match' class='dettaglio-partite-container' style='display:none;'>",
    "<button class='btn-indietro' onclick='tornaAllaListaCampionati()'>⬅️ INDIETRO</button>",
    "<h3 id='titolo-dettaglio-match'>Partite Copiate</h3>",
    "<div class='lista-partite-scroll'>",
    "<table>",
    "<thead id='head-partite-dettaglio'></thead>",
    "<tbody id='tabella-partite-dettaglio'></tbody>",
    "</table>",
    "</div>",
    "</div>",
    "</div>",
    "<div id='tab-view-soglie' class='tab-content'>",
    "<div class='lista-partite-scroll' style='display:block; margin-top:10px; max-height: 500px;'>",
    "<table id='tabella-soglie-globale'></table>",
    "</div>",
    "</div>",
    "<div id='tab-view-console' class='tab-content'>",
    "<div class='status-container'>",
    "<span>Stato Operazione:</span>",
    "<span id='stato-operazione' class='status-bg'>In attesa di avvio manuale</span>",
    "</div>",
    "<div class='progress-container'>",
    "<div id='barra-progresso' class='progress-bar'></div>",
    "</div>",
    "<h3>Console Operativa</h3>",
    "<div id='console-log' class='console-box'>",
    "<p style='color: #666666; margin: 0;'>Pronto. Scegli un'operazione in fondo per iniziare...</p>",
    "</div>",
    "</div>",
    "</div>",
    "<div class='bottom-bar'>",
    "<button id='btn-tab-match' class='btn btn-tab active' onclick='cambiaScheda(\"match\")'><span class='btn-icon'>⚽</span><span class='btn-text'>MATCH</span></button>",
    "<button id='btn-tab-soglie' class='btn btn-tab' onclick='cambiaScheda(\"soglie\")'><span class='btn-icon'>🚨</span><span class='btn-text'>SOGLIE</span></button>",
    "<button id='btn-tab-console' class='btn btn-tab' onclick='cambiaScheda(\"console\")'><span class='btn-icon'>💻</span><span class='btn-text'>CONSOLE</span></button>",
    "<button id='btn-start' class='btn btn-primary' onclick='toggleSincronizzazione()'><span class='btn-icon'>▶️</span><span class='btn-text'>AVVIA</span></button>",
    "<button id='btn-reset' class='btn btn-reset' onclick='confermaReset()'><span class='btn-icon'>⛔</span><span class='btn-text'>RESET</span></button>",
    "</div>",
    "<script>",
    "var campionatiInteri = [];",
    "var semaforiTutti = [];",
    "var schedaAttiva = 'match';",
    "var nitroAttiva = false;",
    "var calcoloSoglieAttivo = false;",
    "var elaborazioneInCorso = false;",
    "var nazioneSelezionata = '';",
    "var campionatoSelezionato = '';",
    "var bandieraSelezionata = '';",
    "var listaEsiti = " + JSON.stringify(listaEsiti) + ";",
    "var mappaBandiereDinamica = " + JSON.stringify(mappaBandiereDinamica) + ";",
    "function cambiaScheda(nome) {",
    "  schedaAttiva = nome;",
    "  document.querySelectorAll('.btn-tab').forEach(function(b) { b.classList.remove('active'); });",
    "  document.querySelectorAll('.tab-content').forEach(function(c) { c.classList.remove('active'); });",
    "  if (nome === 'match') {",
    "    document.getElementById('btn-tab-match').classList.add('active');",
    "    document.getElementById('tab-view-match').classList.add('active');",
    "    tornaAllaListaCampionati();",
    "  } else if (nome === 'soglie') {",
    "    document.getElementById('btn-tab-soglie').classList.add('active');",
    "    document.getElementById('tab-view-soglie').classList.add('active');",
    "  } else {",
    "    document.getElementById('btn-tab-console').classList.add('active');",
    "    document.getElementById('tab-view-console').classList.add('active');",
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
    "function calcolaPercentualeSincro(dati) {",
    "  if (!dati.length) return 0;",
    "  var completati = dati.filter(function(item) { return item.stato === 'COMPLETED'; }).length;",
    "  return Math.round((completati / dati.length) * 100);",
    "}",
    "function calcolaPercentualeSoglie(dati) {",
    "  if (!dati.length) return 0;",
    "  var completati = dati.filter(function(item) { return item.stato_soglie === 'COMPLETED'; }).length;",
    "  return Math.round((completati / dati.length) * 100);",
    "}",
    "function aggiornaBarraProgresso() {",
    "  if (!campionatiInteri.length) return;",
    "  var perc = 0;",
    "  if (calcoloSoglieAttivo) {",
    "    perc = calcolaPercentualeSoglie(campionatiInteri);",
    "  } else {",
    "    perc = calcolaPercentualeSincro(campionatiInteri);",
    "  }",
    "  document.getElementById('barra-progresso').style.width = perc + '%';",
    "}",
    "function ottieniStatoSincro(stato) {",
    "  var s = stato.toUpperCase();",
    "  if (s === 'PENDING') return '⚪';",
    "  if (s === 'PROCESSING') return '🔵';",
    "  if (s === 'COMPLETED') return '🟢';",
    "  return '⚪';",
    "}",
    "function ottieniStatoSemafori(stato) {",
    "  var s = stato.toUpperCase();",
    "  if (s === 'PENDING') return '🔴';",
    "  if (s === 'PROCESSING') return '🟡';",
    "  if (s === 'COMPLETED') return '🟢';",
    "  return '🔴';",
    "}",
    "function ottieniStatoSoglie(stato) {",
    "  var s = stato.toUpperCase();",
    "  if (s === 'PENDING') return '🔴';",
    "  if (s === 'PROCESSING') return '💡';",
    "  if (s === 'COMPLETED') return '🟢';",
    "  return '🔴';",
    "}",
    "function renderizzaCampionatiPartite(dati) {",
    "  var container = document.getElementById('lista-partite-campionati');",
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
    "    var valoreCentrale = document.createElement('div');",
    "    valoreCentrale.className = 'valore-centrale';",
    "    var dotSinc = document.createElement('span');",
    "    dotSinc.className = 'badge-stato';",
    "    dotSinc.textContent = ottieniStatoSincro(item.stato);",
    "    var dotSem = document.createElement('span');",
    "    dotSem.className = 'badge-stato';",
    "    dotSem.textContent = ottieniStatoSemafori(item.stato_semafori);",
    "    var dotSog = document.createElement('span');",
    "    dotSog.className = 'badge-stato';",
    "    dotSog.textContent = ottieniStatoSoglie(item.stato_soglie);",
    "    valoreCentrale.appendChild(dotSinc);",
    "    valoreCentrale.appendChild(dotSem);",
    "    valoreCentrale.appendChild(dotSog);",
    "    var valoreDestra = document.createElement('div');",
    "    valoreDestra.className = 'valore-destra';",
    "    valoreDestra.textContent = 'match ' + (item.match_elaborati || 0);",
    "    card.appendChild(infoSinistra);",
    "    card.appendChild(valoreCentrale);",
    "    card.appendChild(valoreDestra);",
    "    container.appendChild(card);",
    "  });",
    "}",
    "function renderizzaMatriceSoglie(campionati, semafori) {",
    "  var table = document.getElementById('tabella-soglie-globale');",
    "  table.innerHTML = '';",
    "  var htmlHead = '<tr><th style=\"position:sticky;left:0;z-index:20;background-color:#0c0c0c;\">LEGA</th>';",
    "  listaEsiti.forEach(function(es) {",
    "    htmlHead += '<th>' + es + '</th>';",
    "  });",
    "  htmlHead += '</tr>';",
    "  var mappaSoglie = {};",
    "  semafori.forEach(function(s) {",
    "    var chiave = s.campionato + '_' + s.esito;",
    "    mappaSoglie[chiave] = s;",
    "  });",
    "  var htmlBody = '';",
    "  campionati.forEach(function(item) {",
    "    htmlBody += '<tr>';",
    "    htmlBody += '<td style=\"font-weight:bold;background-color:#0c0c0c;position:sticky;left:0;z-index:10;text-align:left;\">' + item.bandiera + ' ' + item.campionato + '</td>';",
    "    listaEsiti.forEach(function(es) {",
    "      var chiave = item.campionato + '_' + es;",
    "      var s = mappaSoglie[chiave];",
    "      if (s) {",
    "        var colSemaforo = '#10b981';",
    "        var bgSemaforo = '#061c15';",
    "        var borderSemaforo = '#0c4a34';",
    "        if (s.semaforo === 'GIALLO') {",
    "          colSemaforo = '#f59e0b';",
    "          bgSemaforo = '#211504';",
    "          borderSemaforo = '#452403';",
    "        }",
    "        if (s.semaforo === 'ROSSO') {",
    "          colSemaforo = '#ef4444';",
    "          bgSemaforo = '#220808';",
    "          borderSemaforo = '#4c1111';",
    "        }",
    "        htmlBody += '<td style=\"color:' + colSemaforo + ';background-color:' + bgSemaforo + ';border:1px solid ' + borderSemaforo + ';font-weight:bold;\">' + Math.round(s.soglia_attiva) + '%</td>';",
    "      } else {",
    "        htmlBody += '<td style=\"color:#444;\">-</td>';",
    "      }",
    "    });",
    "    htmlBody += '</tr>';",
    "  });",
    "  table.innerHTML = htmlHead + htmlBody;",
    "}",
    "async function mostraDettaglioPartite(nazione, campionato, bandiera, stato) {",
    "  if (stato !== 'COMPLETED') {",
    "    alert('Puoi visualizzare l anteprima solo per i campionati completati.');",
    "    return;",
    "  }",
    "  nazioneSelezionata = nazione;",
    "  campionatoSelezionato = campionato;",
    "  bandieraSelezionata = bandiera;",
    "  var listaCard = document.getElementById('lista-partite-campionati');",
    "  var pannello = document.getElementById('pannello-dettaglio-match');",
    "  var titolo = document.getElementById('titolo-dettaglio-match');",
    "  var thead = document.getElementById('head-partite-dettaglio');",
    "  var tbody = document.getElementById('tabella-partite-dettaglio');",
    "  titolo.textContent = bandiera + ' ' + campionato + ' - Match Salvati';",
    "  tbody.innerHTML = '<tr><td colspan=25 style=\"text-align:center;color:#666;\">Caricamento in corso...</td></tr>';",
    "  listaCard.style.display = 'none';",
    "  pannello.style.display = 'block';",
    "  try {",
    "    var res = await fetch('/api/partite-salvate?nazione=' + encodeURIComponent(nazione) + '&campionato=' + encodeURIComponent(campionato));",
    "    if (res.ok) {",
    "      var partite = await res.json();",
    "      tbody.innerHTML = '';",
    "      if (partite.length === 0) {",
    "        tbody.innerHTML = '<tr><td colspan=25 style=\"text-align:center;\">Nessuna partita copiata</td></tr>';",
    "        return;",
    "      }",
    "      var htmlHead = '<tr><th>Data</th><th>Partita</th><th>Ris.</th>';",
    "      listaEsiti.forEach(function(es) {",
    "        htmlHead += '<th>' + es + '</th>';",
    "      });",
    "      htmlHead += '</tr>';",
    "      thead.innerHTML = htmlHead;",
    "      partite.forEach(function(p) {",
    "        var tr = document.createElement('tr');",
    "        var tdData = document.createElement('td');",
    "        tdData.textContent = p.date;",
    "        tr.appendChild(tdData);",
    "        var tdPartita = document.createElement('td');",
    "        tdPartita.textContent = p.home_team + ' - ' + p.away_team;",
    "        tr.appendChild(tdPartita);",
    "        var tdRis = document.createElement('td');",
    "        tdRis.textContent = p.fthg + '-' + p.ftag;",
    "        tr.appendChild(tdRis);",
    "        listaEsiti.forEach(function(es) {",
    "          var tdEs = document.createElement('td');",
    "          var prob = 0;",
    "          if (es === '1') prob = p.prob_1;",
    "          else if (es === 'X') prob = p.prob_X;",
    "          else if (es === '2') prob = p.prob_2;",
    "          else if (es === 'GG') prob = p.prob_gg;",
    "          else if (es === 'NG') prob = p.prob_ng;",
    "          else if (es === 'U05') prob = p.prob_u05;",
    "          else if (es === 'O05') prob = p.prob_o05;",
    "          else if (es === 'U15') prob = p.prob_u15;",
    "          else if (es === 'O15') prob = p.prob_o15;",
    "          else if (es === 'U25') prob = p.prob_u25;",
    "          else if (es === 'O25') prob = p.prob_o25;",
    "          else if (es === 'U35') prob = p.prob_u35;",
    "          else if (es === 'O35') prob = p.prob_o35;",
    "          else if (es === 'U45') prob = p.prob_u45;",
    "          else if (es === 'O45') prob = p.prob_o45;",
    "          else if (es === 'SG0') prob = p.prob_sg0;",
    "          else if (es === 'SG1') prob = p.prob_sg1;",
    "          else if (es === 'SG2') prob = p.prob_sg2;",
    "          else if (es === 'SG3') prob = p.prob_sg3;",
    "          else if (es === 'SG4') prob = p.prob_sg4;",
    "          else if (es === 'SG5') prob = p.prob_sg5;",
    "          else if (es === 'SG6p') prob = p.prob_sg6p;",
    "          tdEs.textContent = Math.round(prob * 100) + '%';",
    "          tr.appendChild(tdEs);",
    "        });",
    "        tbody.appendChild(tr);",
    "      });",
    "    }",
    "  } catch(e) {",
    "    tbody.innerHTML = '<tr><td colspan=25 style=\"text-align:center;color:red;\">Errore connessione</td></tr>';",
    "  }",
    "}",
    "function tornaAllaListaCampionati() {",
    "  document.getElementById('lista-partite-campionati').style.display = 'block';",
    "  document.getElementById('pannello-dettaglio-match').style.display = 'none';",
    "}",
    "async function aggiornaStato() {",
    "  try {",
    "    var res = await fetch('/api/stato');",
    "    if (res.ok) {",
    "      campionatiInteri = await res.json();",
    "      renderizzaCampionatiPartite(campionatiInteri);",
    "      aggiornaBarraProgresso();",
    "      eseguiLoopSincronizzazione();",
    "      eseguiLoopSoglie();",
    "    }",
    "    var resSoglie = await fetch('/api/semafori-tutti');",
    "    if (resSoglie.ok) {",
    "      semaforiTutti = await resSoglie.json();",
    "      renderizzaMatriceSoglie(campionatiInteri, semaforiTutti);",
    "    }",
    "  } catch(e) {",
    "    scriviLog('Errore aggiornamento dati: ' + e.message, 'error');",
    "  }",
    "}",
    "function toggleSincronizzazione() {",
    "  var btn = document.getElementById('btn-start');",
    "  if (nitroAttiva || calcoloSoglieAttivo) {",
    "    nitroAttiva = false;",
    "    calcoloSoglieAttivo = false;",
    "    btn.innerHTML = \"<span class='btn-icon'>▶️</span><span class='btn-text'>AVVIA</span>\";",
    "    btn.className = 'btn btn-primary';",
    "    document.getElementById('stato-operazione').textContent = 'In pausa (Manuale)';",
    "    document.getElementById('stato-operazione').className = 'status-bg';",
    "    scriviLog('Sincronizzazione e calcolo messi in pausa dall\\'utente.', 'info');",
    "  } else {",
    "    nitroAttiva = true;",
    "    btn.innerHTML = \"<span class='btn-icon'>⏸️</span><span class='btn-text'>PAUSA</span>\";",
    "    btn.className = 'btn btn-primary active';",
    "    document.getElementById('stato-operazione').textContent = 'Modalità Nitro Attiva (Copia Match)';",
    "    document.getElementById('stato-operazione').className = 'status-nitro';",
    "    scriviLog('Inizio copia reale dei dati guidata dal client...', 'info');",
    "    aggiornaStato();",
    "  }",
    "}",
    "async function eseguiLoopSincronizzazione() {",
    "  if (!nitroAttiva || elaborazioneInCorso) return;",
    "  var prossimo = campionatiInteri.find(function(item) { return item.stato === 'PENDING'; });",
    "  if (!prossimo) {",
    "    scriviLog('Sincronizzazione match completata con successo! Avvio calcolo automatico dei semafori e soglie...', 'success');",
    "    nitroAttiva = false;",
    "    calcoloSoglieAttivo = true;",
    "    document.getElementById('stato-operazione').textContent = 'Modalità Nitro Attiva (Calcolo Semafori)';",
    "    document.getElementById('stato-operazione').className = 'status-nitro';",
    "    await aggiornaStato();",
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
    "    document.getElementById('stato-operazione').textContent = 'Processo Completato!';",
    "    document.getElementById('stato-operazione').className = 'status-nitro';",
    "    scriviLog('Calcolo terminato. Tutti i dati storici sono stati copiati e calibrati a 72 scenari.', 'success');",
    "    calcoloSoglieAttivo = false;",
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
    "      scriviLog('Elaborato ' + prossimo.campionato + ': Calcolati ' + ris.esiti_calcolati + ' esiti con auto-calibrazione attiva.', 'success');",
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
    "        btnStart.innerHTML = \"<span class='btn-icon'>▶️</span><span class='btn-text'>AVVIA</span>\";",
    "        btnStart.className = 'btn btn-primary';",
    "        document.getElementById('stato-operazione').textContent = 'In attesa di avvio manuale';",
    "        document.getElementById('stato-operazione').className = 'status-bg';",
    "        document.getElementById('pannello-dettaglio-match').style.display = 'none';",
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
    "    scriviLog('Interfaccia inattiva. Il controllo della copia passa al Background Server.', 'info');",
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

  const lottiSincro = await env.DB_SOGLIE.prepare(
    "SELECT nazione, campionato FROM sync_stato_campionati WHERE stato = 'PENDING' LIMIT 2"
  ).all();

  const campionatiSincro = lottiSincro.results || [];
  if (cancellato = campionatiSincro.length > 0) {}
  if (campionatiSincro.length > 0) {
    for (const c of campionatiSincro) {
      await env.DB_SOGLIE.prepare(
        "UPDATE sync_stato_campionati SET stato = 'PROCESSING' WHERE nazione = ? AND campionato = ?"
      ).bind(c.nazione, c.campionato).run();

      await elaboraSincronizzazioneCampionato(env, c.nazione, c.campionato);
    }
    return; 
  }

  const lottiSoglie = await env.DB_SOGLIE.prepare(
    "SELECT nazione, campionato FROM sync_stato_campionati WHERE stato = 'COMPLETED' AND stato_soglie = 'PENDING' LIMIT 2"
  ).all();

  const campionatiSoglie = lottiSoglie.results || [];
  if (campionatiSoglie.length > 0) {
    for (const c of campionatiSoglie) {
      await env.DB_SOGLIE.prepare(
        "UPDATE sync_stato_campionati SET stato_semafori = 'PROCESSING', stato_soglie = 'PROCESSING' WHERE nazione = ? AND campionato = ?"
      ).bind(c.nazione, c.campionato).run();

      await elaboraSoglieCampionato(env, c.nazione, c.campionato);
    }
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