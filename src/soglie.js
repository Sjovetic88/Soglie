/**
 * CLOUDFLARE WORKER: GOLDBET SOGLIE (ENGINE & DASHBOARD)
 * 
 * Legge da: DB_PRONOSTICI (pronostici_partite) - ID: 6f393ca6-0ebc-4f37-98db-3df8857222ed
 * Scrive in: DB_SOGLIE (soglie_campionati) - ID: 6bde4e75-41f2-40c1-85e7-4abd5a045043
 */

export default {
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);
      const path = url.pathname;

      // 1. ENDPOINT: Dashboard HTML AMOLED Black
      if (path === "/" || path === "/index.html") {
        return new Response(ottieniHTMLDashboardEngine(), {
          status: 200,
          headers: { "Content-Type": "text/html;charset=UTF-8" }
        });
      }

      // 2. ENDPOINT: API per ottenere la lista dinamica dei campionati e i loro stati
      if (path === "/api/campionati") {
        // Estrae l'elenco e l'ultima data disponibile per ogni campionato
        const queryDati = `
          SELECT campionato, MAX(date) as ultima_data, COUNT(*) as totale_match 
          FROM validazione_risultati 
          WHERE campionato IS NOT NULL 
          GROUP BY campionato 
          ORDER BY campionato ASC;
        `;
        const { results: d1Results } = await env.DB_PRONOSTICI.prepare(queryDati).all();

        // Legge le soglie già calcolate nel database delle soglie per mostrare se sono aggiornate
        const querySoglie = `SELECT campionato, date_aggiornamento FROM soglie_attive;`;
        const { results: soglieResults } = await env.DB_SOGLIE.prepare(querySoglie).all();

        const mappaSoglie = new Map(soglieResults.map(s => [s.campionato, s.date_aggiornamento]));

        const listaCampionati = d1Results.map(r => {
          const dataSoglia = mappaSoglie.get(r.campionato);
          return {
            campionato: r.campionato,
            ultima_partita: r.ultima_data,
            totale_match: r.totale_match,
            aggiornato: dataSoglia ? 1 : 0,
            data_aggiornamento: dataSoglia || "-"
          };
        });

        return responseJSON(listaCampionati);
      }

      // 3. ENDPOINT: API per leggere le soglie attive di tutti i campionati
      if (path === "/api/tutte-soglie") {
        const query = `SELECT * FROM soglie_attive ORDER BY campionato ASC;`;
        const { results } = await env.DB_SOGLIE.prepare(query).all();
        return responseJSON(results);
      }

      // 4. ENDPOINT: API streaming per il Backtest in Tempo Reale (SSE)
      if (path === "/backtest") {
        const campionato = url.searchParams.get("campionato");
        if (!campionato) {
          return responseJSON({ error: "Parametro 'campionato' mancante" }, 400);
        }

        // Utilizziamo un canale SSE per inviare aggiornamenti progressivi al client
        const { readable, writable } = new TransformStream();
        const writer = writable.getWriter();
        const encoder = new TextEncoder();

        ctx.waitUntil((async () => {
          try {
            await eseguiBacktestInStreaming(campionato, env, writer, encoder);
          } catch (err) {
            const errorMsg = JSON.stringify({ type: "error", message: err.message });
            await writer.write(encoder.encode(`data: ${errorMsg}\n\n`));
          } finally {
            await writer.close();
          }
        })());

        return new Response(readable, {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "Access-Control-Allow-Origin": "*"
          }
        });
      }

      // 5. ENDPOINT: Ricalcolatore Live rapido
      if (path === "/run-live") {
        ctx.waitUntil(eseguiCalibrazioneLiveTuttiCampionati(env));
        return responseJSON({ status: "Calibrazione live pianificata in background." });
      }

      return responseJSON({ error: "Endpoint non trovato." }, 404);

    } catch (error) {
      return responseJSON({ error: error.message }, 500);
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(eseguiCalibrazioneLiveTuttiCampionati(env));
  }
};

// ==========================================
// UTILITY DI CONFIGURAZIONE E STRUTTURE
// ==========================================

function responseJSON(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*"
    }
  });
}

// ==========================================
// MOTORE DI CALCOLO MATEMATICO & SSE STREAMING
// ==========================================

const LISTA_MERCATI = [
  "1", "X", "2", "gg", "ng",
  "u05", "o05", "u15", "o15", "u25", "o25", "u35", "o35", "u45", "o45",
  "sg0", "sg1", "sg2", "sg3", "sg4", "sg5", "sg6p"
];

const PARAM_FINESTRE = [365, 500, 730, 1000];
const PARAM_RAGGI = [1, 2, 3];
const PARAM_PENALITA = [4, 6, 8, 10, 12, 14];

async function eseguiCalibrazioneLiveTuttiCampionati(env) {
  const queryCampionati = `SELECT DISTINCT campionato FROM validazione_risultati WHERE campionato IS NOT NULL;`;
  const { results } = await env.DB_PRONOSTICI.prepare(queryCampionati).all();
  const oggiYMD = ottieniDataOggiYMD();

  for (const row of results) {
    const campionato = row.campionato;
    try {
      const partiteStoriche = await caricaPartiteStoriche(campionato, oggiYMD, 1000, env);
      if (partiteStoriche.length < 50) continue;

      const calibrazioneOttimale = calibraInMemoria(partiteStoriche);

      await salvaSogliaAttiva(campionato, oggiYMD, calibrazioneOttimale.soglie, env);
      await cacheCalibrazioneGiornaliera(campionato, oggiYMD, calibrazioneOttimale, env);
    } catch (err) {
      console.error(`Errore nel live di ${campionato}:`, err);
    }
  }
}

/**
 * Esegue il backtest matematico trasmettendo i dati passo-passo via Server-Sent Events (SSE)
 */
async function eseguiBacktestInStreaming(campionato, env, writer, encoder) {
  const queryTuttiMatch = `
    SELECT * FROM validazione_risultati 
    WHERE campionato = ? AND date IS NOT NULL AND fthg IS NOT NULL AND ftag IS NOT NULL
    ORDER BY date ASC;
  `;
  const { results: tuttiMatch } = await env.DB_PRONOSTICI.prepare(queryTuttiMatch).bind(campionato).all();

  if (tuttiMatch.length < 150) {
    const msg = JSON.stringify({ type: "error", message: "Dati storici insufficienti per simulare questo campionato (servono almeno 150 match)." });
    await writer.write(encoder.encode(`data: ${msg}\n\n`));
    return;
  }

  // Estrazione della cache delle calibrazioni dal database dedicato
  const cacheCalibrazioni = await caricaCacheCalibrazioni(campionato, env);
  const mappaCache = new Map();
  for (const c of cacheCalibrazioni) {
    mappaCache.set(c.date_calibrazione, c);
  }

  const reportMercati = inizializzaStrutturaReport();
  let totaleGiornateCalcolate = 0;
  let matchesProcessati = 0;
  const totaleMatchesDaSimulare = tuttiMatch.length;
  let queryBatchScrittura = [];

  const dateUniche = [...new Set(tuttiMatch.map(m => m.date))].sort();
  const primaDataSimulabileIdx = trovaIndicePrimaDataUtile(dateUniche, tuttiMatch, 1000);

  if (primaDataSimulabileIdx === -1 || primaDataSimulabileIdx >= dateUniche.length) {
    const msg = JSON.stringify({ type: "error", message: "Dati insufficienti per strutturare i primi 1000 giorni di storico di calibrazione." });
    await writer.write(encoder.encode(`data: ${msg}\n\n`));
    return;
  }

  // Incrementiamo l'indice iniziale nel conteggio dei match già considerati "storico iniziale statico"
  for (let idx = 0; idx < primaDataSimulabileIdx; idx++) {
    const matchesData = tuttiMatch.filter(m => m.date === dateUniche[idx]);
    matchesProcessati += matchesData.length;
  }

  // Ciclo giorno per giorno in tempo reale
  for (let i = primaDataSimulabileIdx; i < dateUniche.length; i++) {
    const dataCorrente = dateUniche[i];
    let soglieGiornata = mappaCache.get(dataCorrente);

    if (!soglieGiornata) {
      const dataLimiteInferiore = calcolaDataMenoGiorni(dataCorrente, 1000);
      const finestraMatch = tuttiMatch.filter(m => m.date >= dataLimiteInferiore && m.date < dataCorrente);

      if (finestraMatch.length >= 50) {
        const calibrazione = calibraInMemoria(finestraMatch);
        soglieGiornata = {
          campionato,
          date_calibrazione: dataCorrente,
          finestra_giorni: calibrazione.finestra_giorni,
          raggio_smussamento: calibrazione.raggio_smussamento,
          penale_applicata: calibrazione.penale_applicata,
          ...calibrazione.soglie
        };

        queryBatchScrittura.push(preparaQuerySalvataggioCache(soglieGiornata, env));
      }
    }

    const matchDelGiorno = tuttiMatch.filter(m => m.date === dataCorrente);
    
    if (soglieGiornata) {
      totaleGiornateCalcolate++;
      for (const match of matchDelGiorno) {
        valutaMatchRispettoAlleSoglie(match, soglieGiornata, reportMercati);
      }
    }

    matchesProcessati += matchDelGiorno.length;

    // Generiamo l'aggiornamento di progresso in diretta streaming per la Dashboard
    if (matchDelGiorno.length > 0) {
      const ultimoMatchStr = `${dataCorrente} | ${matchDelGiorno[0].home_team} - ${matchDelGiorno[0].away_team} ${matchDelGiorno[0].fthg}-${matchDelGiorno[0].ftag}`;
      const percentualeStr = ((matchesProcessati / totaleMatchesDaSimulare) * 100).toFixed(1);
      
      const chunkProgresso = JSON.stringify({
        type: "progress",
        elaborati: matchesProcessati,
        totale: totaleMatchesDaSimulare,
        percentuale: percentualeStr,
        ultimoMatch: ultimoMatchStr
      });

      await writer.write(encoder.encode(`data: ${chunkProgresso}\n\n`));
    }
  }

  // Scrittura finale nel database dedicato delle calibrazioni trovate in background
  if (queryBatchScrittura.length > 0) {
    await env.DB_SOGLIE.batch(queryBatchScrittura);
  }

  // Invio dei risultati finali al termine dello streaming
  const reportRiepilogativo = generaRiepilogoFinalizzato(campionato, totaleMatchesDaSimulare, totaleGiornateCalcolate, reportMercati);
  const chunkFinale = JSON.stringify({
    type: "complete",
    report: reportRiepilogativo
  });

  await writer.write(encoder.encode(`data: ${chunkFinale}\n\n`));
}

function calibraInMemoria(partiteStoriche) {
  let migliorConfigurazione = {
    finestra_giorni: 1000,
    raggio_smussamento: 2,
    penale_applicata: 6,
    punteggio_ottimalita: -1,
    soglie: {}
  };

  const partiteConEsito = partiteStoriche.map(m => ({
    ...m,
    esitiReali: calcolaMappaEsitiReali(m.fthg, m.ftag)
  }));

  for (const finestra of PARAM_FINESTRE) {
    const dataLimite = calcolaDataMenoGiorni(partiteConEsito[partiteConEsito.length - 1].date, finestra);
    const matchFiltrati = partiteConEsito.filter(m => m.date >= dataLimite);

    if (matchFiltrati.length < 30) continue;

    for (const raggio of PARAM_RAGGI) {
      for (const penale of PARAM_PENALITA) {
        const soglieCalcolate = {};
        let sommaPrecisioniSoglie = 0;
        let conteggioMercatiValidi = 0;

        for (const mercato of LISTA_MERCATI) {
          const bs = calcolaBrierScorePerMercato(matchFiltrati, mercato);
          let semaforo = "VERDE";

          if (bs >= 0.72) {
            semaforo = "ROSSO";
          } else if (bs >= 0.68) {
            semaforo = "GIALLO";
          }

          if (semaforo === "ROSSO") {
            soglieCalcolate[mercato] = 100.0;
          } else {
            const sogliaStandard = trovaMiglioreSogliaSmussata(matchFiltrati, mercato, raggio);
            let sogliaAttiva = sogliaStandard;

            if (semaforo === "GIALLO") {
              sogliaAttiva = Math.min(100.0, sogliaStandard + penale);
            }
            soglieCalcolate[mercato] = sogliaAttiva;

            const accuratezzaSoglia = valutaPrecisioneSogliaSuCampione(matchFiltrati, mercato, sogliaAttiva);
            if (accuratezzaSoglia !== null) {
              sommaPrecisioniSoglie += accuratezzaSoglia;
              conteggioMercatiValidi++;
            }
          }
        }

        const punteggioAttuale = conteggioMercatiValidi > 0 ? (sommaPrecisioniSoglie / conteggioMercatiValidi) : 0;

        if (punteggioAttuale > migliorConfigurazione.punteggio_ottimalita) {
          migliorConfigurazione = {
            finestra_giorni: finestra,
            raggio_smussamento: raggio,
            penale_applicata: penale,
            punteggio_ottimalita: punteggioAttuale,
            soglie: soglieCalcolate
          };
        }
      }
    }
  }

  if (migliorConfigurazione.punteggio_ottimalita === -1) {
    const defaultSoglie = {};
    for (const m of LISTA_MERCATI) defaultSoglie[m] = 70.0;
    migliorConfigurazione.soglie = defaultSoglie;
  }

  return {
    finestra_giorni: migliorConfigurazione.finestra_giorni,
    raggio_smussamento: migliorConfigurazione.raggio_smussamento,
    penale_applicata: migliorConfigurazione.penale_applicata,
    soglie: migliorConfigurazione.soglie
  };
}

function calcolaBrierScorePerMercato(matchList, mercato) {
  let sommaErroriQuadratici = 0;
  let conteggio = 0;

  for (const m of matchList) {
    const prob = m[`prob_${mercato}`];
    const reale = m.esitiReali[mercato];

    if (prob !== undefined && prob !== null && reale !== undefined) {
      const errore = prob - reale;
      sommaErroriQuadratici += errore * errore;
      conteggio++;
    }
  }

  return conteggio > 0 ? (sommaErroriQuadratici / conteggio) : 1.0;
}

function trovaMiglioreSogliaSmussata(matchList, mercato, raggio) {
  const precisioniSoglie = {};

  for (let t = 40; t <= 85; t++) {
    let scommesseConsigliate = 0;
    let scommesseVinte = 0;
    const sogliaDecimale = t / 100.0;

    for (const m of matchList) {
      const prob = m[`prob_${mercato}`];
      if (prob !== undefined && prob !== null && prob >= sogliaDecimale) {
        scommesseConsigliate++;
        if (m.esitiReali[mercato] === 1) {
          scommesseVinte++;
        }
      }
    }

    precisioniSoglie[t] = scommesseConsigliate >= 5 ? (scommesseVinte / scommesseConsigliate) : 0.0;
  }

  let miglioreSogliaStandard = 65;
  let mediaVicinatoMigliore = -1;

  for (let t = 45; t <= 80; t++) {
    let sommaPrecisioni = 0;
    let divisore = 0;

    for (let offset = -raggio; offset <= raggio; offset++) {
      const tVicino = t + offset;
      if (precisioniSoglie[tVicino] !== undefined) {
        sommaPrecisioni += precisioniSoglie[tVicino];
        divisore++;
      }
    }

    const mediaVicinato = divisore > 0 ? (sommaPrecisioni / divisore) : 0;

    if (mediaVicinato > mediaVicinatoMigliore) {
      mediaVicinatoMigliore = mediaVicinato;
      miglioreSogliaStandard = t;
    }
  }

  return miglioreSogliaStandard;
}

function valutaPrecisioneSogliaSuCampione(matchList, mercato, valoreSoglia) {
  let consigliate = 0;
  let vinte = 0;
  const sogliaDecimale = valoreSoglia / 100.0;

  for (const m of matchList) {
    const prob = m[`prob_${mercato}`];
    if (prob !== undefined && prob !== null && prob >= sogliaDecimale) {
      consigliate++;
      if (m.esitiReali[mercato] === 1) {
        vinte++;
      }
    }
  }

  return consigliate >= 3 ? (vinte / consigliate) : null;
}

function calcolaMappaEsitiReali(fthg, ftag) {
  const sum = fthg + ftag;
  const gg = (fthg > 0 && ftag > 0) ? 1 : 0;
  return {
    "1": fthg > ftag ? 1 : 0,
    "X": fthg === ftag ? 1 : 0,
    "2": fthg < ftag ? 1 : 0,
    "gg": gg,
    "ng": gg === 1 ? 0 : 1,
    "u05": sum < 0.5 ? 1 : 0,
    "o05": sum > 0.5 ? 1 : 0,
    "u15": sum < 1.5 ? 1 : 0,
    "o15": sum > 1.5 ? 1 : 0,
    "u25": sum < 2.5 ? 1 : 0,
    "o25": sum > 2.5 ? 1 : 0,
    "u35": sum < 3.5 ? 1 : 0,
    "o35": sum > 3.5 ? 1 : 0,
    "u45": sum < 4.5 ? 1 : 0,
    "o45": sum > 4.5 ? 1 : 0,
    "sg0": sum === 0 ? 1 : 0,
    "sg1": sum === 1 ? 1 : 0,
    "sg2": sum === 2 ? 1 : 0,
    "sg3": sum === 3 ? 1 : 0,
    "sg4": sum === 4 ? 1 : 0,
    "sg5": sum === 5 ? 1 : 0,
    "sg6p": sum >= 6 ? 1 : 0
  };
}

// ==========================================
// FUNZIONI DI GESTIONE DATI E FILE SYSTEM D1
// ==========================================

async function caricaPartiteStoriche(campionato, dataRiferimento, giorniIndietro, env) {
  const dataInizio = calcolaDataMenoGiorni(dataRiferimento, giorniIndietro);
  const query = `
    SELECT * FROM validazione_risultati 
    WHERE campionato = ? 
      AND date >= ? 
      AND date < ?
      AND fthg IS NOT NULL 
      AND ftag IS NOT NULL
    ORDER BY date ASC;
  `;
  const { results } = await env.DB_PRONOSTICI.prepare(query).bind(campionato, dataInizio, dataRiferimento).all();
  return results;
}

async function salvaSogliaAttiva(campionato, dataOggi, soglie, env) {
  const query = `
    INSERT INTO soglie_attive (
      campionato, date_aggiornamento,
      soglia_1, soglia_X, soglia_2, soglia_gg, soglia_ng,
      soglia_u05, soglia_o05, soglia_u15, soglia_o15, soglia_u25, soglia_o25,
      soglia_u35, soglia_o35, soglia_u45, soglia_o45,
      soglia_sg0, soglia_sg1, soglia_sg2, soglia_sg3, soglia_sg4, soglia_sg5, soglia_sg6p
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
    ) ON CONFLICT(campionato) DO UPDATE SET
      date_aggiornamento = excluded.date_aggiornamento,
      soglia_1=excluded.soglia_1, soglia_X=excluded.soglia_X, soglia_2=excluded.soglia_2,
      soglia_gg=excluded.soglia_gg, soglia_ng=excluded.soglia_ng,
      soglia_u05=excluded.soglia_u05, soglia_o05=excluded.soglia_o05, soglia_u15=excluded.soglia_u15, soglia_o15=excluded.soglia_o15,
      soglia_u25=excluded.soglia_u25, soglia_o25=excluded.soglia_o25, soglia_u35=excluded.soglia_u35, soglia_o35=excluded.soglia_o35,
      soglia_u45=excluded.soglia_u45, soglia_o45=excluded.soglia_o45,
      soglia_sg0=excluded.soglia_sg0, soglia_sg1=excluded.soglia_sg1, soglia_sg2=excluded.soglia_sg2,
      soglia_sg3=excluded.soglia_sg3, soglia_sg4=excluded.soglia_sg4, soglia_sg5=excluded.soglia_sg5, soglia_sg6p=excluded.soglia_sg6p;
  `;

  await env.DB_SOGLIE.prepare(query).bind(
    campionato, dataOggi,
    soglie["1"], soglie["X"], soglie["2"], soglie["gg"], soglie["ng"],
    soglie["u05"], soglie["o05"], soglie["u15"], soglie["o15"], soglie["u25"], soglie["o25"],
    soglie["u35"], soglie["o35"], soglie["u45"], soglie["o45"],
    soglie["sg0"], soglie["sg1"], soglie["sg2"], soglie["sg3"], soglie["sg4"], soglie["sg5"], soglie["sg6p"]
  ).run();
}

async function cacheCalibrazioneGiornaliera(campionato, dataCalibrazione, calibrazione, env) {
  const payload = {
    campionato,
    date_calibrazione: dataCalibrazione,
    finestra_giorni: calibrazione.finestra_giorni,
    raggio_smussamento: calibrazione.raggio_smussamento,
    penale_applicata: calibrazione.penale_applicata,
    ...calibrazione.soglie
  };
  const stmt = preparaQuerySalvataggioCache(payload, env);
  await stmt.run();
}

function preparaQuerySalvataggioCache(d, env) {
  const query = `
    INSERT INTO calibrazioni_giornaliere (
      campionato, date_calibrazione, finestra_giorni, raggio_smussamento, penale_applicata,
      soglia_1, soglia_X, soglia_2, soglia_gg, soglia_ng,
      soglia_u05, soglia_o05, soglia_u15, soglia_o15, soglia_u25, soglia_o25,
      soglia_u35, soglia_o35, soglia_u45, soglia_o45,
      soglia_sg0, soglia_sg1, soglia_sg2, soglia_sg3, soglia_sg4, soglia_sg5, soglia_sg6p
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
    ) ON CONFLICT(campionato, date_calibrazione) DO UPDATE SET
      finestra_giorni=excluded.finestra_giorni,
      raggio_smussamento=excluded.raggio_smussamento,
      penale_applicata=excluded.penale_applicata,
      soglia_1=excluded.soglia_1, soglia_X=excluded.soglia_X, soglia_2=excluded.soglia_2,
      soglia_gg=excluded.soglia_gg, soglia_ng=excluded.soglia_ng,
      soglia_u05=excluded.soglia_u05, soglia_o05=excluded.soglia_o05, soglia_u15=excluded.soglia_u15, soglia_o15=excluded.soglia_o15,
      soglia_u25=excluded.soglia_u25, soglia_o25=excluded.soglia_o25, soglia_u35=excluded.soglia_u35, soglia_o35=excluded.soglia_o35,
      soglia_u45=excluded.soglia_u45, soglia_o45=excluded.soglia_o45,
      soglia_sg0=excluded.soglia_sg0, soglia_sg1=excluded.soglia_sg1, soglia_sg2=excluded.soglia_sg2,
      soglia_sg3=excluded.soglia_sg3, soglia_sg4=excluded.soglia_sg4, soglia_sg5=excluded.soglia_sg5, soglia_sg6p=excluded.soglia_sg6p;
  `;
  return env.DB_SOGLIE.prepare(query).bind(
    d.campionato, d.date_calibrazione, d.finestra_giorni, d.raggio_smussamento, d.penale_applicata,
    d.soglia_1, d.soglia_X, d.soglia_2, d.soglia_gg, d.soglia_ng,
    d.soglia_u05, d.soglia_o05, d.soglia_u15, d.soglia_o15, d.soglia_u25, d.soglia_o25,
    d.soglia_u35, d.soglia_o35, d.soglia_u45, d.soglia_o45,
    d.soglia_sg0, d.soglia_sg1, d.soglia_sg2, d.soglia_sg3, d.soglia_sg4, d.soglia_sg5, d.soglia_sg6p
  );
}

async function caricaCacheCalibrazioni(campionato, env) {
  const query = `SELECT * FROM calibrazioni_giornaliere WHERE campionato = ?;`;
  const { results } = await env.DB_SOGLIE.prepare(query).bind(campionato).all();
  return results;
}

function ottieniDataOggiYMD() {
  const d = new Date();
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function calcolaDataMenoGiorni(dataRiferimentoYMD, giorni) {
  const d = new Date(dataRiferimentoYMD);
  d.setDate(d.getDate() - giorni);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function trovaIndicePrimaDataUtile(dateUniche, tuttiMatch, giorniMinimi) {
  if (dateUniche.length === 0) return -1;
  const primaDataAssoluta = dateUniche[0];

  for (let i = 0; i < dateUniche.length; i++) {
    const differenzaGiorni = (new Date(dateUniche[i]) - new Date(primaDataAssoluta)) / (1000 * 60 * 60 * 24);
    if (differenzaGiorni >= giorniMinimi) {
      return i;
    }
  }
  return -1;
}

function inizializzaStrutturaReport() {
  const report = {};
  for (const m of LISTA_MERCATI) {
    report[m] = { scommesseConsigliate: 0, scommesseVinte: 0 };
  }
  return report;
}

function generaRiepilogoFinalizzato(campionato, totalePartite, totaleGiornateCalcolate, reportMercati) {
  const mercatiDettaglio = {};
  let totaleConsigliateGlobali = 0;
  let totaleVinteGlobali = 0;

  for (const m of LISTA_MERCATI) {
    const dati = reportMercati[m];
    const precisione = dati.scommesseConsigliate > 0 
      ? Number(((dati.scommesseVinte / dati.scommesseConsigliate) * 100).toFixed(2)) 
      : 0;

    mercatiDettaglio[m] = {
      consigliate: dati.scommesseConsigliate,
      vinte: dati.scommesseVinte,
      precisione_percentuale: precisione
    };

    totaleConsigliateGlobali += dati.scommesseConsigliate;
    totaleVinteGlobali += dati.scommesseVinte;
  }

  const precisioneGlobale = totaleConsigliateGlobali > 0 
    ? Number(((totaleVinteGlobali / totaleConsigliateGlobali) * 100).toFixed(2)) 
    : 0;

  return {
    campionato,
    partite_analizzate: totalePartite,
    giornate_simulate: totaleGiornateCalcolate,
    riepilogo_generale: {
      totale_consigliate: totaleConsigliateGlobali,
      totale_vinte: totaleVinteGlobali,
      precisione_media: precisioneGlobale
    },
    esiti: mercatiDettaglio
  };
}

// ==========================================
// INTERFACCIA GRAFICA INTEGRATA (GOLDBET SOGLIE)
// ==========================================

function ottieniHTMLDashboardEngine() {
  return `
<!DOCTYPE html>
<html lang="it">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
    <title>GOLDBET SOGLIE</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;700;900&display=swap" rel="stylesheet">
    <style>
        body {
            font-family: 'Inter', sans-serif;
            background-color: #000000;
            color: #ffffff;
            -webkit-tap-highlight-color: transparent;
        }
        .amoled-card {
            background-color: #0d0d0d;
            border: 1px solid #1c1c1e;
        }
        .neon-cyan {
            color: #00e5ff;
            text-shadow: 0 0 10px rgba(0, 229, 255, 0.2);
        }
        .border-neon {
            border-color: rgba(0, 229, 255, 0.4);
            box-shadow: 0 0 10px rgba(0, 229, 255, 0.1);
        }
        .bottom-nav {
            background-color: #000000;
            border-top: 1px solid #1c1c1e;
        }
        .no-scrollbar::-webkit-scrollbar { display: none; }
        .no-scrollbar { -ms-overflow-style: none; scrollbar-width: none; }
    </style>
</head>
<body class="overflow-x-hidden min-h-screen pb-24">

    <!-- COMPONENTE SUPERIORE - MONITOR STATISTICHE REAL-TIME -->
    <div class="sticky top-0 z-50 bg-black/90 backdrop-blur-md border-b border-zinc-900 py-4 px-4">
        <div class="max-w-md mx-auto text-center">
            <h1 class="text-2xl font-black uppercase tracking-wider mb-0.5">
                GOLDBET <span class="neon-cyan">SOGLIE</span>
            </h1>
            
            <!-- CONTATORI DI AVANZAMENTO IN DIRETTA SSE -->
            <div id="sse-progress-container" class="hidden my-2">
                <div class="text-xs font-black text-white tracking-widest uppercase">
                    <span id="sse-count-match">0 / 0</span> MATCHES | <span id="sse-percent" class="neon-cyan">0.0%</span>
                </div>
                <div class="text-[9px] text-gray-500 font-bold uppercase tracking-wider overflow-hidden text-ellipsis whitespace-nowrap mt-1 px-4" id="sse-current-match">
                    INIZIALIZZAZIONE SIMULAZIONE IN MEMORIA...
                </div>
            </div>

            <!-- STATO DI BASE -->
            <div id="home-static-stats" class="text-[10px] text-gray-400 font-bold uppercase tracking-widest mt-1">
                SISTEMA PRONTO PER L'ELABORAZIONE
            </div>
        </div>
    </div>

    <!-- MAIN WRAPPER (MAX-WIDTH SMARTPHONE) -->
    <div class="max-w-md mx-auto px-4 mt-4">

        <!-- SEZIONE 1: HOME TAB (ELENCO CAMPIONATI) -->
        <div id="tab-home" class="space-y-3">
            <h2 class="text-xs font-bold text-gray-500 uppercase tracking-widest mb-2 px-1">Seleziona Competizione Attiva</h2>
            <div id="lista-campionati-container" class="space-y-2.5">
                <div class="py-12 text-center text-zinc-600">Caricamento campionati in corso...</div>
            </div>
        </div>

        <!-- SEZIONE 2: SOGLIE LIVE TAB (TUTTI GLI ESITI DI TUTTI I CAMPIONATI) -->
        <div id="tab-soglie" class="hidden space-y-4">
            <div class="flex justify-between items-center mb-1">
                <h2 class="text-xs font-bold text-gray-500 uppercase tracking-widest">Soglie Operative Live</h2>
                <input type="text" id="filtro-soglie" oninput="filtraSoglieInDiretta()" placeholder="Cerca campionato..." class="bg-[#0d0d0d] border border-zinc-800 text-[10px] rounded-lg px-2 py-1 text-white focus:outline-none focus:border-cyan-400 w-1/2">
            </div>
            
            <div id="soglie-globali-container" class="space-y-3">
                <!-- Generato Dinamicamente tramite Fisarmonica (Accordion) -->
                <div class="py-12 text-center text-zinc-600">Caricamento database soglie...</div>
            </div>
        </div>

        <!-- SEZIONE 3: SCHERMATA DETTAGLIATA RISULTATI BACKTEST (DOPO L'AVVIO) -->
        <div id="tab-risultati" class="hidden space-y-4">
            <div class="flex items-center gap-3 border-b border-zinc-800 pb-3 justify-between">
                <div>
                    <h2 id="backtest-campionato-nome" class="text-lg font-black uppercase text-white">SERIE A</h2>
                    <p class="text-[9px] text-zinc-500 uppercase font-bold">Resoconto simulato senza Look-Ahead Bias</p>
                </div>
                <button onclick="tornaAllaHome()" class="text-cyan-400 text-xs font-bold uppercase tracking-wider px-2 py-1 border border-cyan-400/20 rounded">Indietro</button>
            </div>

            <div class="grid grid-cols-3 gap-2 text-center">
                <div class="bg-[#0d0d0d] p-3 rounded-xl border border-zinc-900">
                    <span class="text-[8px] text-zinc-500 block uppercase font-bold">Match</span>
                    <span id="res-partite" class="text-base font-black text-white">-</span>
                </div>
                <div class="bg-[#0d0d0d] p-3 rounded-xl border border-zinc-900">
                    <span class="text-[8px] text-zinc-500 block uppercase font-bold">Consigliati</span>
                    <span id="res-consigliate" class="text-base font-black text-teal-400">-</span>
                </div>
                <div class="bg-[#0d0d0d] p-3 rounded-xl border border-zinc-900">
                    <span class="text-[8px] text-zinc-500 block uppercase font-bold">Precisione</span>
                    <span id="res-precisione" class="text-base font-black text-cyan-400">-</span>
                </div>
            </div>

            <div id="risultati-esiti-container" class="space-y-2">
                <!-- Elenco dei 22 esiti simulati -->
            </div>
        </div>

    </div>

    <!-- BARRA DI NAVIGAZIONE INFERIORE (BOTTOM DOCK) -->
    <nav class="fixed bottom-0 left-0 right-0 max-w-md mx-auto z-40 bottom-nav h-16 flex items-center justify-around px-2">
        
        <!-- HOME BUTTON -->
        <button id="nav-btn-home" onclick="cambiaTab('home')" class="flex flex-col items-center justify-center w-16 h-12 text-cyan-400 transition">
            <svg class="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h3m-6 0a1 1 0 001-1v-4a1 1 0 00-1-1h-3a1 1 0 00-1 1v4a1 1 0 001 1m-6 0h6"></path>
            </svg>
            <span class="text-[8px] font-bold uppercase tracking-wider mt-1">Home</span>
        </button>

        <!-- SOGLIE LIVE BUTTON -->
        <button id="nav-btn-soglie" onclick="cambiaTab('soglie')" class="flex flex-col items-center justify-center w-16 h-12 text-zinc-500 hover:text-white transition">
            <svg class="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-3 7h3m-3 4h3m-6-4h.01M9 16h.01"></path>
            </svg>
            <span class="text-[8px] font-bold uppercase tracking-wider mt-1">Soglie Live</span>
        </button>

        <!-- NITRO BUTTON (MASS BACKGROUND RUN) -->
        <button id="nav-btn-nitro" onclick="lanciaNitroBulk()" class="flex flex-col items-center justify-center w-16 h-12 text-zinc-500 hover:text-orange-400 transition">
            <svg class="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 10V3L4 14h7v7l9-11h-7z"></path>
            </svg>
            <span class="text-[8px] font-bold uppercase tracking-wider mt-1">Nitro</span>
        </button>

        <!-- RESET BUTTON -->
        <button onclick="eseguiResetGenerale()" class="flex flex-col items-center justify-center w-16 h-12 text-zinc-500 hover:text-red-500 transition">
            <svg class="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path>
            </svg>
            <span class="text-[8px] font-bold uppercase tracking-wider mt-1">Reset</span>
        </button>

    </nav>

    <!-- LOGICA DI FUNZIONAMENTO FRONTEND -->
    <script>
        let campionatiCache = [];
        let soglieCache = [];
        let sseSource = null;

        window.addEventListener('DOMContentLoaded', async () => {
            await scaricaDatiIniziali();
        });

        async function scaricaDatiIniziali() {
            await scaricaCampionatiHome();
            await scaricaSoglieGlobali();
        }

        // 1. CARICAMENTO DATI PER LA SCHERMATA HOME
        async function scaricaCampionatiHome() {
            const container = document.getElementById('lista-campionati-container');
            try {
                const res = await fetch('/api/campionati');
                campionatiCache = await res.json();
                
                container.innerHTML = '';
                campionatiCache.forEach(item => {
                    const card = document.createElement('div');
                    card.id = \`card-\${item.campionato.replace(/\\s+/g, '-')}\`;
                    card.className = "amoled-card rounded-xl p-4 transition duration-200 flex flex-col gap-3";
                    
                    // Colore badge di aggiornamento
                    const badgeColore = item.aggiornato ? "text-cyan-400 bg-cyan-950/40" : "text-zinc-600 bg-zinc-950/40";
                    const badgeTesto = item.aggiornato ? "CALIBRATO" : "IN ATTESA";

                    card.innerHTML = \`
                        <div class="flex justify-between items-center">
                            <div>
                                <h3 class="text-sm font-black uppercase text-white tracking-wide">\${item.campionato}</h3>
                                <p class="text-[9px] text-zinc-500 font-semibold uppercase tracking-wider mt-0.5">
                                    Ultimo Match: \${item.ultima_partita || "-"} | Match: \${item.totale_match}
                                </p>
                            </div>
                            <div class="text-right">
                                <span class="text-[8px] font-black px-2 py-1 rounded \${badgeColore} tracking-widest uppercase">
                                    \${badgeTesto}
                                </span>
                            </div>
                        </div>
                        <div class="flex gap-2 mt-1">
                            <button onclick="avviaMotoreBacktest('\${item.campionato}')" class="flex-1 bg-gradient-to-r from-cyan-500 to-blue-600 hover:from-cyan-600 hover:to-blue-700 text-black font-black py-2 rounded-lg text-[10px] uppercase tracking-widest transition shadow-lg">
                                Avvia Backtest
                            </button>
                            <button onclick="calibraLiveSingolo('\${item.campionato}')" class="px-3 bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 rounded-lg text-[10px] font-black uppercase tracking-widest text-zinc-300">
                                Calibra Live
                            </button>
                        </div>
                    \`;
                    container.appendChild(card);
                });
            } catch (err) {
                container.innerHTML = \`<div class="text-center py-10 text-red-500 text-xs font-bold">Errore di comunicazione: \${err.message}</div>\`;
            }
        }

        // 2. BACKTEST CON STREAMING REAL-TIME (SSE)
        function avviaMotoreBacktest(campionato) {
            // Selezioniamo visivamente la card per dare riscontro
            const cardId = \`card-\${campionato.replace(/\\s+/g, '-')}\`;
            const card = document.getElementById(cardId);
            if (card) card.className = "amoled-card rounded-xl p-4 transition duration-200 border-neon";

            // Attiviamo l'interfaccia streaming superiore
            const sseContainer = document.getElementById('sse-progress-container');
            const staticStats = document.getElementById('home-static-stats');
            sseContainer.classList.remove('hidden');
            staticStats.classList.add('hidden');

            document.getElementById('sse-count-match').textContent = "0 / 0";
            document.getElementById('sse-percent').textContent = "0.0%";
            document.getElementById('sse-current-match').textContent = "AVVIO CANALE STREAMING WORKER...";

            // Disattiviamo temporaneamente i bottoni per evitare richieste multiple
            document.querySelectorAll('button').forEach(b => b.disabled = true);

            // Apriamo la connessione SSE al Worker
            if (sseSource) sseSource.close();
            sseSource = new EventSource(\`/backtest?campionato=\${encodeURIComponent(campionato)}\`);

            sseSource.onmessage = function(event) {
                const data = JSON.parse(event.data);

                if (data.type === "progress") {
                    document.getElementById('sse-count-match').textContent = \`\${data.elaborati} / \${data.totale}\`;
                    document.getElementById('sse-percent').textContent = data.percentuale + "%";
                    document.getElementById('sse-current-match').textContent = data.ultimoMatch.toUpperCase();
                } 
                
                else if (data.type === "complete") {
                    sseSource.close();
                    finalizzaUIBacktest(data.report);
                } 
                
                else if (data.type === "error") {
                    sseSource.close();
                    alert("Errore calcolo: " + data.message);
                    ripristinaControlli();
                }
            };

            sseSource.onerror = function() {
                sseSource.close();
                alert("Canale di streaming interrotto improvvisamente dal server.");
                ripristinaControlli();
            };
        }

        function finalizzaUIBacktest(report) {
            ripristinaControlli();

            // Nascondiamo l'SSE
            document.getElementById('sse-progress-container').classList.add('hidden');
            document.getElementById('home-static-stats').classList.remove('hidden');

            // Cambiamo tab visualizzando i risultati di backtest
            cambiaTab('risultati');

            document.getElementById('backtest-campionato-nome').textContent = report.campionato;
            document.getElementById('res-partite').textContent = report.partite_analizzate;
            document.getElementById('res-consigliate').textContent = report.riepilogo_generale.totale_consigliate;
            document.getElementById('res-precisione').textContent = report.riepilogo_generale.precisione_media + "%";

            const container = document.getElementById('risultati-esiti-container');
            container.innerHTML = '';

            Object.keys(report.esiti).forEach(mercato => {
                const dati = report.esiti[mercato];
                const card = document.createElement('div');
                card.className = "amoled-card rounded-xl p-3 flex justify-between items-center";

                let coloreTesto = "text-[#00e5ff]";
                if (dati.precisione_percentuale < 55) coloreTesto = "text-red-500";
                else if (dati.precisione_percentuale < 70) coloreTesto = "text-amber-500";

                card.innerHTML = \`
                    <div>
                        <span class="text-xs font-black uppercase text-white tracking-wide">\${mercato.toUpperCase()}</span>
                        <span class="text-[8px] text-zinc-500 font-bold block mt-0.5">
                            SUGGERITI: \${dati.consigliate} | VINTE: \${dati.vinte}
                        </span>
                    </div>
                    <div class="text-right">
                        <span class="text-sm font-black \${coloreTesto}">
                            \${dati.precisione_percentuale.toFixed(1)}%
                        </span>
                    </div>
                \`;
                container.appendChild(card);
            });
        }

        function ripristinaControlli() {
            document.querySelectorAll('button').forEach(b => b.disabled = false);
            campionatiCache.forEach(item => {
                const cardId = \`card-\${item.campionato.replace(/\\s+/g, '-')}\`;
                const card = document.getElementById(cardId);
                if (card) card.className = "amoled-card rounded-xl p-4 transition duration-200 flex flex-col gap-3";
            });
        }

        // 3. SEZIONE SOGLIE LIVE (FISARMONICA / ACCORDION COMPLETO)
        async function scaricaSoglieGlobali() {
            const container = document.getElementById('soglie-globali-container');
            try {
                const res = await fetch('/api/tutte-soglie');
                soglieCache = await res.json();

                if (soglieCache.length === 0) {
                    container.innerHTML = \`<div class="text-center py-10 text-zinc-500 text-xs font-bold uppercase">Nessuna soglia calcolata nel database.</div>\`;
                    return;
                }

                costruisciFisarmonicaSoglie(soglieCache);
            } catch (err) {
                container.innerHTML = \`<div class="text-center py-10 text-red-500 text-xs font-bold">Errore caricamento soglie: \${err.message}</div>\`;
            }
        }

        function costruisciFisarmonicaSoglie(listaSoglie) {
            const container = document.getElementById('soglie-globali-container');
            container.innerHTML = '';

            listaSoglie.forEach((item, index) => {
                const wrapper = document.createElement('div');
                wrapper.className = "amoled-card rounded-xl overflow-hidden item-soglia-filtro";
                wrapper.dataset.campionato = item.campionato.toLowerCase();

                // Esiti aggregati per visualizzazione rapida
                wrapper.innerHTML = \`
                    <!-- Intestazione cliccabile della fisarmonica -->
                    <button onclick="toggleAccordion(\${index})" class="w-full text-left px-4 py-4 flex justify-between items-center hover:bg-zinc-950 transition">
                        <div>
                            <span class="text-xs font-black uppercase text-white tracking-wide">\${item.campionato}</span>
                            <span class="text-[8px] text-zinc-500 font-bold block mt-0.5 uppercase tracking-widest">
                                Aggiornato il: \${item.date_aggiornamento}
                            </span>
                        </div>
                        <div class="flex items-center gap-3">
                            <span class="text-[8px] font-black text-cyan-400 bg-cyan-950/40 px-2 py-0.5 rounded tracking-widest">SFOGLIA</span>
                            <svg id="arrow-\${index}" class="h-4 w-4 text-zinc-500 transition-transform duration-200" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"></path>
                            </svg>
                        </div>
                    </button>
                    
                    <!-- Corpo espandibile con i 22 esiti -->
                    <div id="body-\${index}" class="hidden p-4 border-t border-zinc-900 bg-black grid grid-cols-2 sm:grid-cols-3 gap-2">
                        \${costruisciGriglia22Soglie(item)}
                    </div>
                \`;
                container.appendChild(wrapper);
            });
        }

        function costruisciGriglia22Soglie(sogliaData) {
            let html = '';
            const mercatiNomi = Object.keys(sogliaData).filter(k => k.startsWith('soglia_'));

            mercatiNomi.forEach(key => {
                const nomeMercato = key.replace('soglia_', '').toUpperCase();
                const valore = sogliaData[key];
                const bloccato = valore >= 100;

                html += \`
                    <div class="bg-[#0a0a0b] p-2.5 rounded-lg border border-zinc-900 text-center">
                        <div class="text-[8px] text-zinc-500 font-bold uppercase">\${nomeMercato}</div>
                        <div class="text-xs font-black mt-1 \${bloccato ? 'text-red-500' : 'text-cyan-400'}">
                            \${bloccato ? 'BLOCKED' : valore.toFixed(1) + '%'}
                        </div>
                    </div>
                \`;
            });
            return html;
        }

        function toggleAccordion(index) {
            const body = document.getElementById(\`body-\${index}\`);
            const arrow = document.getElementById(\`arrow-\${index}\`);

            if (body.classList.contains('hidden')) {
                body.classList.remove('hidden');
                body.classList.add('grid');
                arrow.classList.add('rotate-180');
            } else {
                body.classList.add('hidden');
                body.classList.remove('grid');
                arrow.classList.remove('rotate-180');
            }
        }

        function filtraSoglieInDiretta() {
            const query = document.getElementById('filtro-soglie').value.toLowerCase();
            const elementi = document.querySelectorAll('.item-soglia-filtro');

            elementi.forEach(el => {
                const nomeCamp = el.dataset.campionato;
                if (nomeCamp.includes(query)) {
                    el.classList.remove('hidden');
                } else {
                    el.classList.add('hidden');
                }
            });
        }

        // 4. NAVIGAZIONE INTERNA TRA TAB
        function cambiaTab(tabNome) {
            document.getElementById('tab-home').classList.add('hidden');
            document.getElementById('tab-soglie').classList.add('hidden');
            document.getElementById('tab-risultati').classList.add('hidden');

            document.getElementById(\`tab-\${tabNome}\`).classList.remove('hidden');

            // Reset visivo pulsanti menu
            document.getElementById('nav-btn-home').className = "flex flex-col items-center justify-center w-16 h-12 text-zinc-500 hover:text-white transition";
            document.getElementById('nav-btn-soglie').className = "flex flex-col items-center justify-center w-16 h-12 text-zinc-500 hover:text-white transition";
            document.getElementById('nav-btn-nitro').className = "flex flex-col items-center justify-center w-16 h-12 text-zinc-500 hover:text-white transition";

            if (tabNome === 'home') {
                document.getElementById('nav-btn-home').className = "flex flex-col items-center justify-center w-16 h-12 text-cyan-400 transition";
            } else if (tabNome === 'soglie') {
                document.getElementById('nav-btn-soglie').className = "flex flex-col items-center justify-center w-16 h-12 text-cyan-400 transition";
                scaricaSoglieGlobali(); // rinfresca il visualizzatore globale
            }
        }

        function tornaAllaHome() {
            cambiaTab('home');
        }

        // 5. CALIBRAZIONI LIVE INDIVIDUALI O GENERALI
        async function calibraLiveSingolo(campionato) {
            if (!confirm("Ricalcolare ora le soglie live giornaliere di: " + campionato + "?")) return;
            try {
                const res = await fetch(\`/run-live?campionato=\${encodeURIComponent(campionato)}\`);
                alert("Processo pianificato. Tra qualche secondo aggiorna per vedere lo stato.");
                await scaricaDatiIniziali();
            } catch (err) {
                alert("Errore: " + err.message);
            }
        }

        async function lanciaNitroBulk() {
            if (!confirm("Ricalcolare le soglie live per tutti i campionati in background?")) return;
            try {
                const res = await fetch('/run-live');
                alert("Nitro avviato con successo in background su Cloudflare.");
            } catch (err) {
                alert("Errore Nitro: " + err.message);
            }
        }

        function eseguiResetGenerale() {
            if (sseSource) sseSource.close();
            resetUICompletamente();
            scaricaDatiIniziali();
        }

        function resetUICompletamente() {
            document.getElementById('sse-progress-container').classList.add('hidden');
            document.getElementById('home-static-stats').classList.remove('hidden');
            document.getElementById('home-static-stats').textContent = "SISTEMA PRONTO PER L'ELABORAZIONE";
            document.querySelectorAll('button').forEach(b => b.disabled = false);
            cambiaTab('home');
        }
    </script>
</body>
</html>
  `;
}