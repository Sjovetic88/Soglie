/**
 * CLOUDFLARE WORKER: SOGLIE & BACKTEST CON INTERFACCIA GRAFICA "ENGINE"
 * 
 * Legge da: DB_PRONOSTICI (pronostici_partite) - ID: 6f393ca6-0ebc-4f37-98db-3df8857222ed
 * Scrive in: DB_SOGLIE (soglie_campionati) - ID: 6bde4e75-41f2-40c1-85e7-4abd5a045043
 */

export default {
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);
      const path = url.pathname;

      // 1. INTERFACCIA GRAFICA: Dashboard AMOLED Black (Stile Engine App)
      if (path === "/" || path === "/index.html") {
        return new Response(ottieniHTMLDashboardEngine(), {
          status: 200,
          headers: { "Content-Type": "text/html;charset=UTF-8" }
        });
      }

      // 2. API: Estrazione dei campionati per la tendina a comparsa
      if (path === "/api/campionati") {
        const query = `SELECT DISTINCT campionato FROM validazione_risultati WHERE campionato IS NOT NULL ORDER BY campionato ASC;`;
        const { results } = await env.DB_PRONOSTICI.prepare(query).all();
        const lista = results.map(r => r.campionato);
        return responseJSON(lista);
      }

      // 3. API: Lettura delle soglie operative attuali
      if (path === "/api/soglie-attive") {
        const campionato = url.searchParams.get("campionato");
        if (!campionato) return responseJSON({ error: "Campionato mancante" }, 400);

        const query = `SELECT * FROM soglie_attive WHERE campionato = ?;`;
        const result = await env.DB_SOGLIE.prepare(query).bind(campionato).first();
        return responseJSON(result || { messaggio: "Nessuna soglia attiva registrata." });
      }

      // 4. API: Esecuzione del Backtest Storico
      if (path === "/backtest") {
        const campionato = url.searchParams.get("campionato");
        if (!campionato) return responseJSON({ error: "Parametro 'campionato' mancante" }, 400);
        
        const report = await eseguiBacktestStorico(campionato, env);
        return responseJSON(report);
      }

      // 5. API: Ricalcolo Live di tutti i campionati
      if (path === "/run-live") {
        ctx.waitUntil(eseguiCalibrazioneLiveTuttiCampionati(env));
        return responseJSON({ status: "Calibrazione live avviata in background per tutti i campionati" });
      }

      return responseJSON({ error: "Endpoint non trovato." }, 404);

    } catch (error) {
      return responseJSON({ error: error.message, stack: error.stack }, 500);
    }
  },

  async scheduled(event, env, ctx) {
    console.log("Inizio calibrazione notturna pianificata...");
    ctx.waitUntil(eseguiCalibrazioneLiveTuttiCampionati(env));
  }
};

// ==========================================
// SUPPORTO RISPOSTE E UTILITY
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
// MOTORE MATEMATICO & DATABASE CALCOLI
// ==========================================

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

async function eseguiBacktestStorico(campionato, env) {
  const queryTuttiMatch = `
    SELECT * FROM validazione_risultati 
    WHERE campionato = ? AND date IS NOT NULL AND fthg IS NOT NULL AND ftag IS NOT NULL
    ORDER BY date ASC;
  `;
  const { results: tuttiMatch } = await env.DB_PRONOSTICI.prepare(queryTuttiMatch).bind(campionato).all();

  if (tuttiMatch.length < 150) {
    return { error: "Dati insufficienti per il backtest (servono almeno 150 match)." };
  }

  const cacheCalibrazioni = await caricaCacheCalibrazioni(campionato, env);
  const mappaCache = new Map();
  for (const c of cacheCalibrazioni) {
    mappaCache.set(c.date_calibrazione, c);
  }

  const reportMercati = inizializzaStrutturaReport();
  let totaleGiornateCalcolate = 0;
  let queryBatchScrittura = [];

  const dateUniche = [...new Set(tuttiMatch.map(m => m.date))].sort();
  const primaDataSimulabileIdx = trovaIndicePrimaDataUtile(dateUniche, tuttiMatch, 1000);

  if (primaDataSimulabileIdx === -1 || primaDataSimulabileIdx >= dateUniche.length) {
    return { error: "Impossibile accumulare 1000 giorni di storico iniziale per la simulazione." };
  }

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

    if (!soglieGiornata) continue;
    totaleGiornateCalcolate++;

    const matchDelGiorno = tuttiMatch.filter(m => m.date === dataCorrente);
    for (const match of matchDelGiorno) {
      valutaMatchRispettoAlleSoglie(match, soglieGiornata, reportMercati);
    }
  }

  if (queryBatchScrittura.length > 0) {
    await env.DB_SOGLIE.batch(queryBatchScrittura);
  }

  return generaRiepilogoFinalizzato(campionato, tuttiMatch.length, totaleGiornateCalcolate, reportMercati);
}

// ==========================================
// LOGICA MATEMATICA CORE
// ==========================================

const LISTA_MERCATI = [
  "1", "X", "2", "gg", "ng",
  "u05", "o05", "u15", "o15", "u25", "o25", "u35", "o35", "u45", "o45",
  "sg0", "sg1", "sg2", "sg3", "sg4", "sg5", "sg6p"
];

const PARAM_FINESTRE = [365, 500, 730, 1000];
const PARAM_RAGGI = [1, 2, 3];
const PARAM_PENALITA = [4, 6, 8, 10, 12, 14];

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
// FUNZIONI DI GESTIONE DATI & DB
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

function valutaMatchRispettoAlleSoglie(match, soglie, report) {
  const esitiInCorso = calcolaMappaEsitiReali(match.fthg, match.ftag);

  for (const mercato of LISTA_MERCATI) {
    const prob = match[`prob_${mercato}`];
    const sogliaValore = soglie[`soglia_${mercato}`];

    if (prob !== undefined && prob !== null && sogliaValore !== undefined && sogliaValore !== null) {
      const limiteDecimale = sogliaValore / 100.0;
      if (prob >= limiteDecimale) {
        report[mercato].scommesseConsigliate++;
        if (esitiInCorso[mercato] === 1) {
          report[mercato].scommesseVinte++;
        }
      }
    }
  }
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
// INTERFACCIA GRAFICA INTERATTIVA (AMOLED BLACK ENGINE)
// ==========================================

function ottieniHTMLDashboardEngine() {
  return `
<!DOCTYPE html>
<html lang="it">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
    <title>SOGLIE & BACKTEST ENGINE</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;700;900&display=swap" rel="stylesheet">
    <style>
        body {
            font-family: 'Inter', sans-serif;
            background-color: #000000;
            color: #ffffff;
            -webkit-tap-highlight-color: transparent;
        }
        /* AMOLED Card Design */
        .engine-card {
            background-color: #0d0d0d;
            border: 1px solid #1a1a1c;
        }
        /* Neon text pulse effect */
        .neon-accent {
            color: #00e5ff;
            text-shadow: 0 0 10px rgba(0, 229, 255, 0.2);
        }
        /* Bottom navigation shadow */
        .bottom-dock {
            background-color: #000000;
            border-top: 1px solid #1c1c1e;
        }
        /* Hide scrollbars but keep functionality */
        .no-scrollbar::-webkit-scrollbar {
            display: none;
        }
        .no-scrollbar {
            -ms-overflow-style: none;
            scrollbar-width: none;
        }
    </style>
</head>
<body class="overflow-x-hidden min-h-screen pb-24">

    <!-- CONTENITORE CENTRALE -->
    <div class="max-w-md mx-auto px-4 pt-6">

        <!-- INTESTAZIONE PRINCIPALE STILE APP GOLDBET -->
        <header class="text-center mb-6">
            <h1 class="text-2xl font-black uppercase tracking-wider mb-1">
                SOGLIE <span class="neon-accent">ENGINE</span>
            </h1>
            <div id="stato-allineamento" class="text-[10px] text-gray-500 font-bold uppercase tracking-widest mb-1">
                SELEZIONA COMPETIZIONE PER INIZIARE
            </div>
            <div id="data-ultimo-calcolo" class="text-[10px] text-gray-400 font-semibold tracking-wider uppercase">
                ULTIMA ELABORAZIONE: -
            </div>
        </header>

        <!-- SEZIONE DEI 22 MERCATI (VISUALIZZATA IN DIRETTA) -->
        <main class="space-y-2.5" id="contenuto-principale">
            <!-- Messaggio di base prima della selezione -->
            <div class="py-20 text-center text-gray-600">
                <svg class="h-10 w-10 mx-auto text-gray-700 mb-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"></path>
                </svg>
                <p class="text-xs font-bold uppercase tracking-wider">Nessun Campionato Selezionato</p>
                <p class="text-[10px] text-gray-500 mt-1">Usa la barra inferiore [SELECT] per scegliere una lega.</p>
            </div>
        </main>

    </div>

    <!-- CASSETTO SELEZIONE CAMPIONATI (DRAWER SLIDE-UP) -->
    <div id="drawer-campionati" class="fixed inset-y-0 inset-x-0 bg-black/80 backdrop-blur-sm z-50 transition-opacity duration-300 opacity-0 pointer-events-none">
        <div class="absolute bottom-0 left-0 right-0 max-w-md mx-auto bg-[#0d0d0d] border-t border-zinc-800 rounded-t-3xl max-h-[80vh] flex flex-col transition-transform duration-300 translate-y-full">
            <div class="p-4 border-b border-zinc-900 flex justify-between items-center shrink-0">
                <span class="text-xs font-black uppercase text-gray-400 tracking-wider">Scegli Campionato</span>
                <button onclick="chiudiDrawer()" class="text-gray-500 hover:text-white text-xs font-bold uppercase">Chiudi</button>
            </div>
            <div class="overflow-y-auto no-scrollbar p-3 space-y-1" id="drawer-lista-campionati">
                <!-- Generato Dinamicamente -->
            </div>
        </div>
    </div>

    <!-- BARRA DI NAVIGAZIONE INFERIORE (BOTTOM DOCK) -->
    <nav class="fixed bottom-0 left-0 right-0 max-w-md mx-auto z-40 bottom-dock h-16 flex items-center justify-around px-2">
        
        <!-- SELECT BUTTON -->
        <button onclick="apriDrawer()" class="flex flex-col items-center justify-center w-12 h-12 text-gray-500 hover:text-white transition">
            <svg class="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6h16M4 12h16M4 18h16"></path>
            </svg>
            <span class="text-[8px] font-bold uppercase tracking-wider mt-1">Select</span>
        </button>

        <!-- PROCESS BUTTON -->
        <button onclick="lanciaCalibrazioneLive()" class="flex flex-col items-center justify-center w-12 h-12 text-gray-500 hover:text-white transition">
            <svg class="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 1121.21 7.89"></path>
            </svg>
            <span class="text-[8px] font-bold uppercase tracking-wider mt-1">Live</span>
        </button>

        <!-- START (RUN BACKTEST) BUTTON -->
        <button id="btn-start" onclick="eseguiBacktestEngine()" class="flex flex-col items-center justify-center w-14 h-14 bg-gradient-to-b from-[#121212] to-[#000] border border-[#1c1c1e] rounded-full text-zinc-400 hover:text-[#00e5ff] hover:border-[#00e5ff]/30 shadow-lg -translate-y-2 transition">
            <svg class="h-6 w-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z"></path>
            </svg>
        </button>

        <!-- NITRO BUTTON (BULK RUN) -->
        <button onclick="lanciaNitroBulk()" class="flex flex-col items-center justify-center w-12 h-12 text-gray-500 hover:text-[#ff9100] transition">
            <svg class="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 10V3L4 14h7v7l9-11h-7z"></path>
            </svg>
            <span class="text-[8px] font-bold uppercase tracking-wider mt-1">Nitro</span>
        </button>

        <!-- RESET BUTTON -->
        <button onclick="resetSchermata()" class="flex flex-col items-center justify-center w-12 h-12 text-gray-500 hover:text-red-500 transition">
            <svg class="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path>
            </svg>
            <span class="text-[8px] font-bold uppercase tracking-wider mt-1">Reset</span>
        </button>

    </nav>

    <!-- LOGICA DI FUNZIONAMENTO FRONTEND -->
    <script>
        let campionatoSelezionato = "";
        let listaCampionatiCached = [];

        window.addEventListener('DOMContentLoaded', async () => {
            await scaricaCampionati();
        });

        async function scaricaCampionati() {
            try {
                const res = await fetch('/api/campionati');
                listaCampionatiCached = await res.json();
                popolaDrawerCampionati();
            } catch (err) {
                console.error("Errore caricamento competizioni:", err);
            }
        }

        function popolaDrawerCampionati() {
            const container = document.getElementById('drawer-lista-campionati');
            container.innerHTML = '';
            listaCampionatiCached.forEach(c => {
                const btn = document.createElement('button');
                btn.className = "w-full text-left px-4 py-3 rounded-xl hover:bg-zinc-900 text-sm font-semibold transition text-gray-300 hover:text-white flex justify-between items-center border border-transparent hover:border-zinc-800";
                btn.innerHTML = \`
                    <span>\${c}</span>
                    <span class="text-[10px] text-gray-600 uppercase tracking-widest font-black">Seleziona</span>
                \`;
                btn.onclick = () => selezionaCampionato(c);
                container.appendChild(btn);
            });
        }

        function apriDrawer() {
            const drawer = document.getElementById('drawer-campionati');
            const inner = drawer.querySelector('.absolute');
            drawer.classList.remove('pointer-events-none', 'opacity-0');
            drawer.classList.add('opacity-100');
            inner.classList.remove('translate-y-full');
            inner.classList.add('translate-y-0');
        }

        function chiudiDrawer() {
            const drawer = document.getElementById('drawer-campionati');
            const inner = drawer.querySelector('.absolute');
            drawer.classList.remove('opacity-100');
            drawer.classList.add('pointer-events-none', 'opacity-0');
            inner.classList.remove('translate-y-0');
            inner.classList.add('translate-y-full');
        }

        async function selezionaCampionato(c) {
            campionatoSelezionato = c;
            chiudiDrawer();

            // Aggiorna intestazione
            document.getElementById('stato-allineamento').textContent = c + " | IN ATTESA";
            document.getElementById('stato-allineamento').className = "text-[10px] neon-accent font-bold uppercase tracking-widest mb-1";
            
            await caricaSoglieLiveEngine();
        }

        // Recupera le soglie operative di oggi e le renderizza in stile "Engine Card"
        async function caricaSoglieLiveEngine() {
            const container = document.getElementById('contenuto-principale');
            container.innerHTML = \`
                <div class="py-20 text-center animate-pulse text-zinc-500">
                    <p class="text-xs font-bold uppercase tracking-widest">Caricamento in corso...</p>
                </div>
            \`;

            try {
                const res = await fetch(\`/api/soglie-attive?campionato=\${encodeURIComponent(campionatoSelezionato)}\`);
                const dati = await res.json();

                if (dati.messaggio || dati.error) {
                    container.innerHTML = \`
                        <div class="py-12 text-center text-amber-500/80 engine-card rounded-2xl p-6">
                            <p class="text-xs font-bold uppercase tracking-wider">Nessun Dato Operativo</p>
                            <p class="text-[10px] text-gray-500 mt-2">Le soglie odierne non sono ancora state calcolate. Usa il pulsante [LIVE] o [START] per avviare il motore.</p>
                        </div>
                    \`;
                    return;
                }

                // Imposta l'ultimo calcolo
                document.getElementById('data-ultimo-calcolo').textContent = "ULTIMA ELABORAZIONE: " + (dati.date_aggiornamento || "-");

                container.innerHTML = '';
                Object.keys(dati)
                    .filter(key => key.startsWith('soglia_'))
                    .forEach(key => {
                        const mercatoNome = key.replace('soglia_', '').toUpperCase();
                        const valore = dati[key];
                        const bloccato = valore >= 100;

                        const card = document.createElement('div');
                        card.className = "engine-card rounded-xl p-4 flex justify-between items-center transition hover:border-[#00e5ff]/20";
                        
                        card.innerHTML = \`
                            <div>
                                <span class="text-xs font-black uppercase text-white">\${mercatoNome}</span>
                                <span class="text-[9px] text-zinc-500 font-bold block mt-0.5 uppercase tracking-wider">📊 SOGLIA LIVE DI OGGI</span>
                            </div>
                            <div class="text-right">
                                <span class="text-sm font-black tracking-wide \${bloccato ? 'text-red-500' : 'neon-accent'}">
                                    \${bloccato ? 'BLOCKED' : valore.toFixed(1) + '%'}
                                </span>
                            </div>
                        \`;
                        container.appendChild(card);
                    });

            } catch (err) {
                container.innerHTML = \`<div class="text-center py-10 text-red-500 text-xs font-bold">ERRORE: \${err.message}</div>\`;
            }
        }

        // Lancia la simulazione e popola i dati
        async function eseguiBacktestEngine() {
            if (!campionatoSelezionato) {
                alert("Seleziona prima una competizione tramite il pulsante [SELECT]!");
                return;
            }

            const btnStart = document.getElementById('btn-start');
            const container = document.getElementById('contenuto-principale');
            const stato = document.getElementById('stato-allineamento');

            // Stato di caricamento
            btnStart.classList.add('animate-pulse', 'text-[#00e5ff]', 'border-[#00e5ff]');
            stato.textContent = campionatoSelezionato + " | SIMULAZIONE IN CORSO...";
            
            container.innerHTML = \`
                <div class="py-20 text-center text-zinc-500">
                    <svg class="animate-spin h-8 w-8 mx-auto text-[#00e5ff] mb-4" viewBox="0 0 24 24" fill="none">
                        <circle class="opacity-10" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
                        <path class="opacity-90" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                    </svg>
                    <p class="text-[10px] font-black uppercase tracking-widest text-zinc-400">Ricerca parametri su 72 scenari...</p>
                    <p class="text-[9px] text-zinc-600 mt-1">Confronto dati in memoria senza bias</p>
                </div>
            \`;

            try {
                const res = await fetch(\`/backtest?campionato=\${encodeURIComponent(campionatoSelezionato)}\`);
                const report = await res.json();

                if (report.error) {
                    alert(report.error);
                    await caricaSoglieLiveEngine();
                    return;
                }

                // Fine caricamento
                stato.innerHTML = \`BACKTEST COMPLETATO | PRECISIONE: <span class="neon-accent font-black">\${report.riepilogo_generale.precisione_media}%</span>\`;

                container.innerHTML = '';
                
                // Generazione della lista dei 22 esiti identica allo screenshot
                Object.keys(report.esiti).forEach(mercato => {
                    const dati = report.esiti[mercato];
                    const card = document.createElement('div');
                    card.className = "engine-card rounded-xl p-4 flex justify-between items-center hover:border-zinc-800 transition";

                    // Impostiamo il colore di precisione in neon
                    let colorePercentuale = "text-[#00e5ff]";
                    if (dati.precisione_percentuale < 55) colorePercentuale = "text-red-500";
                    else if (dati.precisione_percentuale < 70) colorePercentuale = "text-amber-500";

                    card.innerHTML = \`
                        <div>
                            <span class="text-xs font-black uppercase text-white tracking-wide">\${mercato.toUpperCase()}</span>
                            <span class="text-[9px] text-zinc-500 font-bold block mt-0.5 uppercase tracking-wider">
                                📅 \${report.giornate_simulate} GOR_SIM | SUGGERITI: \${dati.consigliate} - VINTE: \${dati.vinte}
                            </span>
                        </div>
                        <div class="text-right">
                            <span class="text-sm font-black tracking-wider \${colorePercentuale}">
                                \${dati.precisione_percentuale.toFixed(1)}%
                            </span>
                        </div>
                    \`;
                    container.appendChild(card);
                });

            } catch (err) {
                container.innerHTML = \`<div class="text-center py-10 text-red-500 text-xs font-bold">ERRORE BACKTEST: \${err.message}</div>\`;
            } finally {
                btnStart.classList.remove('animate-pulse', 'text-[#00e5ff]', 'border-[#00e5ff]');
            }
        }

        // Lancia calibrazione manuale
        async function lanciaCalibrazioneLive() {
            if (!campionatoSelezionato) {
                alert("Seleziona prima un campionato!");
                return;
            }
            if (!confirm("Avviare la calibrazione live e calcolare le soglie di oggi per " + campionatoSelezionato + "?")) return;

            try {
                const res = await fetch('/run-live');
                const dati = await res.json();
                alert("Processo avviato! Tra circa 10 secondi aggiorna la pagina per visualizzare le nuove soglie.");
            } catch (err) {
                alert("Errore nell'avvio della calibrazione: " + err.message);
            }
        }

        // Lancia calibrazione massiva
        async function lanciaNitroBulk() {
            if (!confirm("AVVERTENZA: Desideri forzare la ricalibrazione 'NITRO' in background per tutti i 34 campionati? Questa operazione rinfrescherà tutte le soglie.")) return;
            try {
                const res = await fetch('/run-live');
                const dati = await res.json();
                alert("Allineamento Nitro avviato! Le soglie verranno aggiornate in background nel database.");
            } catch (err) {
                alert("Errore nell'avvio Nitro: " + err.message);
            }
        }

        function resetSchermata() {
            campionatoSelezionato = "";
            document.getElementById('stato-allineamento').textContent = "SELEZIONA COMPETIZIONE PER INIZIARE";
            document.getElementById('stato-allineamento').className = "text-[10px] text-gray-500 font-bold uppercase tracking-widest mb-1";
            document.getElementById('data-ultimo-calcolo').textContent = "ULTIMA ELABORAZIONE: -";
            
            const container = document.getElementById('contenuto-principale');
            container.innerHTML = \`
                <div class="py-20 text-center text-gray-600">
                    <svg class="h-10 w-10 mx-auto text-gray-700 mb-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"></path>
                    </svg>
                    <p class="text-xs font-bold uppercase tracking-wider">Nessun Campionato Selezionato</p>
                    <p class="text-[10px] text-gray-500 mt-1">Usa la barra inferiore [SELECT] per scegliere una lega.</p>
                </div>
            \`;
        }
    </script>
</body>
</html>
  `;
}