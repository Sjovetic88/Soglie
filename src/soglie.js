/**
 * CLOUDFLARE WORKER: SOGLIE & BACKTEST CON INTERFACCIA GRAFICA INTEGRATA
 * 
 * Legge da: DB_PRONOSTICI (pronostici_partite) - ID: 6f393ca6-0ebc-4f37-98db-3df8857222ed
 * Scrive in: DB_SOGLIE (soglie_campionati) - ID: 6bde4e75-41f2-40c1-85e7-4abd5a045043
 */

export default {
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);
      const path = url.pathname;

      // 1. ENDPOINT: Interfaccia Grafica Principale (Dashboard HTML/CSS/JS)
      if (path === "/" || path === "/index.html") {
        return new Response(ottieniHTMLDashboard(), {
          status: 200,
          headers: { "Content-Type": "text/html;charset=UTF-8" }
        });
      }

      // 2. ENDPOINT: API per ottenere la lista dinamica dei campionati per la tendina
      if (path === "/api/campionati") {
        const query = `SELECT DISTINCT campionato FROM validazione_risultati WHERE campionato IS NOT NULL ORDER BY campionato ASC;`;
        const { results } = await env.DB_PRONOSTICI.prepare(query).all();
        const lista = results.map(r => r.campionato);
        return responseJSON(lista);
      }

      // 3. ENDPOINT: API per leggere le soglie attive attuali di un campionato
      if (path === "/api/soglie-attive") {
        const campionato = url.searchParams.get("campionato");
        if (!campionato) return responseJSON({ error: "Campionato mancante" }, 400);

        const query = `SELECT * FROM soglie_attive WHERE campionato = ?;`;
        const result = await env.DB_SOGLIE.prepare(query).bind(campionato).first();
        return responseJSON(result || { messaggio: "Nessuna soglia attiva calcolata per questo campionato." });
      }

      // 4. ENDPOINT: Esecuzione Backtest Storico
      if (path === "/backtest") {
        const campionato = url.searchParams.get("campionato");
        if (!campionato) return responseJSON({ error: "Parametro 'campionato' mancante" }, 400);
        
        const report = await eseguiBacktestStorico(campionato, env);
        return responseJSON(report);
      }

      // 5. ENDPOINT: Forzatura manuale calibrazione Live di tutti i campionati
      if (path === "/run-live") {
        ctx.waitUntil(eseguiCalibrazioneLiveTuttiCampionati(env));
        return responseJSON({ status: "Calibrazione live avviata in background per tutti i campionati" });
      }

      return responseJSON({ error: "Endpoint non trovato." }, 404);

    } catch (error) {
      return responseJSON({ error: error.message, stack: error.stack }, 500);
    }
  },

  // Esecuzione automatica notturna tramite Cron Trigger alle 00:00
  async scheduled(event, env, ctx) {
    console.log("Inizio calibrazione notturna pianificata...");
    ctx.waitUntil(eseguiCalibrazioneLiveTuttiCampionati(env));
  }
};

// ==========================================
// FUNZIONI DI SUPPORTO DI RISPOSTA
// ==========================================

function responseJSON(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*" // Consente l'accesso anche in ambiente locale se necessario
    }
  });
}

// ==========================================
// FUNZIONI CORE ARCHITETTURALI
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
      console.error(`Errore nel live del campionato ${campionato}:`, err);
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
    return { error: "Dati storici insufficienti per eseguire un backtest (servono almeno 150 match)." };
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
// MOTORE MATEMATICO DI CALCOLO
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
// FUNZIONI DI GESTIONE DEI DATI E DEI DATABASE
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
// INTERFACCIA WEB (DASHBOARD HTML)
// ==========================================

function ottieniHTMLDashboard() {
  return `
<!DOCTYPE html>
<html lang="it">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Soglie & Backtest Dashboard</title>
    <!-- Tailwind CSS per un design ultra-moderno -->
    <script src="https://cdn.tailwindcss.com"></script>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap" rel="stylesheet">
    <style>
        body { font-family: 'Inter', sans-serif; }
    </style>
</head>
<body class="bg-gray-900 text-gray-100 min-h-screen">

    <div class="container mx-auto px-4 py-8">
        
        <!-- HEADER -->
        <header class="flex flex-col md:flex-row justify-between items-center mb-8 border-b border-gray-800 pb-6 gap-4">
            <div>
                <h1 class="text-3xl font-extrabold text-transparent bg-clip-text bg-gradient-to-r from-teal-400 to-blue-500">
                    Soglie & Backtest
                </h1>
                <p class="text-gray-400 text-sm mt-1">Calibrazione Dinamica ed Elaborazione in Memoria senza Bias</p>
            </div>
            <div class="flex gap-3">
                <button onclick="forzaCalibrazioneLive()" class="bg-gradient-to-r from-amber-500 to-orange-600 hover:from-amber-600 hover:to-orange-700 text-white px-5 py-2.5 rounded-lg text-sm font-semibold transition shadow-lg">
                    Ricalcola Soglie Live (Tutti)
                </button>
            </div>
        </header>

        <!-- CONTROLLO PRINCIPALE -->
        <div class="grid grid-cols-1 lg:grid-cols-3 gap-8 mb-8">
            
            <!-- SELEZIONE CAMPIONATO -->
            <div class="bg-gray-800 p-6 rounded-2xl shadow-xl border border-gray-700/50 flex flex-col justify-between">
                <div>
                    <h2 class="text-lg font-bold text-teal-400 mb-2">1. Seleziona Competizione</h2>
                    <p class="text-gray-400 text-xs mb-4">La lista è caricata dinamicamente dal tuo archivio storico.</p>
                    <select id="select-campionato" onchange="caricaSoglieAttiveSelezionato()" class="w-full bg-gray-950 border border-gray-700 text-gray-100 rounded-lg p-3 text-sm focus:outline-none focus:ring-2 focus:ring-teal-500">
                        <option value="">Caricamento campionati...</option>
                    </select>
                </div>
                <div class="mt-6">
                    <button id="btn-backtest" onclick="avviaBacktest()" class="w-full bg-teal-500 hover:bg-teal-600 text-gray-950 font-bold py-3 rounded-lg text-sm transition shadow-md">
                        Avvia Backtest Storico
                    </button>
                </div>
            </div>

            <!-- CARD SOGLIE ATTIVE LIVE -->
            <div class="lg:col-span-2 bg-gray-800 p-6 rounded-2xl shadow-xl border border-gray-700/50">
                <h2 class="text-lg font-bold text-teal-400 mb-2">2. Soglie Attive di Oggi</h2>
                <p class="text-gray-400 text-xs mb-4">Soglie applicate alle scommesse odierne per evitare mercati instabili.</p>
                <div id="soglie-live-container" class="grid grid-cols-2 sm:grid-cols-4 md:grid-cols-6 gap-3">
                    <p class="text-gray-500 text-sm col-span-full py-4 text-center">Seleziona un campionato per vedere le soglie operative.</p>
                </div>
            </div>

        </div>

        <!-- AREA RISULTATI BACKTEST -->
        <div id="sezione-risultati" class="hidden">
            
            <!-- PANNELLO DETTAGLIO STATISTICHE GENERALI -->
            <div class="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">
                <div class="bg-gray-800/80 p-5 rounded-xl border border-gray-700">
                    <span class="text-xs text-gray-400 font-semibold uppercase tracking-wider block mb-1">Partite Storiche Analizzate</span>
                    <span id="stat-partite" class="text-3xl font-black text-white">-</span>
                </div>
                <div class="bg-gray-800/80 p-5 rounded-xl border border-gray-700">
                    <span class="text-xs text-gray-400 font-semibold uppercase tracking-wider block mb-1">Raccomandazioni Generate</span>
                    <span id="stat-consigliate" class="text-3xl font-black text-teal-400">-</span>
                </div>
                <div class="bg-gray-800/80 p-5 rounded-xl border border-gray-700">
                    <span class="text-xs text-gray-400 font-semibold uppercase tracking-wider block mb-1">Precisione Media Modello</span>
                    <span id="stat-precisione" class="text-3xl font-black text-blue-400">-</span>
                </div>
            </div>

            <!-- TABELLA DI CONFRONTO DEI 22 ESITI -->
            <div class="bg-gray-800 rounded-2xl border border-gray-700 overflow-hidden shadow-2xl">
                <div class="p-5 border-b border-gray-700">
                    <h3 class="font-bold text-lg text-white">Analisi Dettagliata per Singolo Esito</h3>
                    <p class="text-gray-400 text-xs mt-1">Confronto delle prestazioni reali filtrate tramite le soglie calcolate.</p>
                </div>
                <div class="overflow-x-auto">
                    <table class="w-full text-left border-collapse">
                        <thead>
                            <tr class="bg-gray-950 text-gray-400 text-xs uppercase tracking-wider border-b border-gray-800">
                                <th class="p-4">Esito / Mercato</th>
                                <th class="p-4">Suggerite</th>
                                <th class="p-4">Vinte</th>
                                <th class="p-4 text-right">Precisione Reale</th>
                            </tr>
                        </thead>
                        <tbody id="tabella-corpo" class="divide-y divide-gray-800 text-sm">
                            <!-- Popolato via Javascript -->
                        </tbody>
                    </table>
                </div>
            </div>

        </div>

        <!-- INDICATORE DI CARICAMENTO -->
        <div id="loader" class="hidden flex-col items-center justify-center py-20">
            <svg class="animate-spin h-12 w-12 text-teal-400 mb-4" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
                <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
            </svg>
            <p class="text-gray-400 text-sm animate-pulse">Elaborazione in corso nel Cloudflare Worker...</p>
            <p class="text-gray-600 text-xs mt-1">Nessun sovraccarico sul database: calcolo interamente in memoria.</p>
        </div>

    </div>

    <!-- FUNZIONALITÀ FRONTEND -->
    <script>
        // Al caricamento della pagina, scarichiamo la lista dei campionati disponibili
        window.addEventListener('DOMContentLoaded', async () => {
            try {
                const res = await fetch('/api/campionati');
                const campionati = await res.json();
                
                const select = document.getElementById('select-campionato');
                select.innerHTML = '<option value="">-- Scegli un campionato --</option>';
                
                campionati.forEach(c => {
                    const opt = document.createElement('option');
                    opt.value = c;
                    opt.textContent = c;
                    select.appendChild(opt);
                });
            } catch (err) {
                alert("Errore nel caricamento dei campionati dal database: " + err.message);
            }
        });

        // Legge le soglie attive oggi dal database "soglie_campionati"
        async function caricaSoglieAttiveSelezionato() {
            const campionato = document.getElementById('select-campionato').value;
            const container = document.getElementById('soglie-live-container');
            
            if (!campionato) {
                container.innerHTML = '<p class="text-gray-500 text-sm col-span-full py-4 text-center">Seleziona un campionato per vedere le soglie operative.</p>';
                return;
            }

            container.innerHTML = '<p class="text-gray-400 text-sm col-span-full py-4 text-center animate-pulse">Caricamento soglie...</p>';

            try {
                const res = await fetch(\`/api/soglie-attive?campionato=\${encodeURIComponent(campionato)}\`);
                const dati = await res.json();

                if (dati.messaggio || dati.error) {
                    container.innerHTML = \`<p class="text-amber-500 text-xs col-span-full py-4 text-center">\${dati.messaggio || dati.error}</p>\`;
                    return;
                }

                container.innerHTML = '';
                const mercatiMappa = Object.keys(dati)
                    .filter(key => key.startsWith('soglia_'))
                    .map(key => ({
                        nome: key.replace('soglia_', '').toUpperCase(),
                        valore: dati[key]
                    }));

                mercatiMappa.forEach(m => {
                    const block = document.createElement('div');
                    block.className = "bg-gray-950 p-3 rounded-lg border border-gray-800 text-center";
                    
                    // Se la soglia è impostata al 100%, significa che il semaforo per quel mercato era rosso
                    const rosso = m.valore >= 100;
                    
                    block.innerHTML = \`
                        <div class="text-[10px] text-gray-500 font-bold">\${m.nome}</div>
                        <div class="text-lg font-black mt-1 \${rosso ? 'text-red-500' : 'text-teal-400'}">
                            \${rosso ? 'BLOCKED' : m.valore + '%'}
                        </div>
                    \`;
                    container.appendChild(block);
                });

            } catch (err) {
                container.innerHTML = \`<p class="text-red-500 text-xs col-span-full py-4 text-center">Errore nel caricamento delle soglie: \${err.message}</p>\`;
            }
        }

        // Avvia la simulazione storica
        async function avviaBacktest() {
            const campionato = document.getElementById('select-campionato').value;
            if (!campionato) {
                alert("Seleziona prima un campionato!");
                return;
            }

            const loader = document.getElementById('loader');
            const sezioneRisultati = document.getElementById('sezione-risultati');
            const btn = document.getElementById('btn-backtest');

            loader.classList.remove('hidden');
            sezioneRisultati.classList.add('hidden');
            btn.disabled = true;

            try {
                const res = await fetch(\`/backtest?campionato=\${encodeURIComponent(campionato)}\`);
                const report = await res.json();

                if (report.error) {
                    alert(report.error);
                    loader.classList.add('hidden');
                    btn.disabled = false;
                    return;
                }

                // Popolamento Statistiche generali
                document.getElementById('stat-partite').textContent = report.partite_analizzate;
                document.getElementById('stat-consigliate').textContent = report.riepilogo_generale.totale_consigliate;
                document.getElementById('stat-precisione').textContent = report.riepilogo_generale.precisione_media + "%";

                // Popolamento tabella mercati
                const tbody = document.getElementById('tabella-corpo');
                tbody.innerHTML = '';

                Object.keys(report.esiti).forEach(mercato => {
                    const dati = report.esiti[mercato];
                    const tr = document.createElement('tr');
                    tr.className = "hover:bg-gray-800/40 transition";
                    
                    let coloreBarra = "bg-red-500";
                    if (dati.precisione_percentuale >= 70) coloreBarra = "bg-teal-400";
                    else if (dati.precisione_percentuale >= 55) coloreBarra = "bg-amber-400";

                    tr.innerHTML = \`
                        <td class="p-4 font-semibold text-gray-200 uppercase text-xs">\${mercato}</td>
                        <td class="p-4 text-gray-300">\${dati.consigliate}</td>
                        <td class="p-4 text-gray-300">\${dati.vinte}</td>
                        <td class="p-4">
                            <div class="flex items-center justify-end gap-3">
                                <span class="font-bold text-white">\${dati.precisione_percentuale}%</span>
                                <div class="w-24 bg-gray-700 h-2 rounded-full overflow-hidden hidden sm:block">
                                    <div class="h-full \${coloreBarra}" style="width: \${dati.precisione_percentuale}%"></div>
                                </div>
                            </div>
                        </td>
                    \`;
                    tbody.appendChild(tr);
                });

                sezioneRisultati.classList.remove('hidden');

            } catch (err) {
                alert("Errore durante il calcolo del backtest: " + err.message);
            } finally {
                loader.classList.add('hidden');
                btn.disabled = false;
            }
        }

        // Forza manualmente l'allineamento e il calcolo notturno delle soglie
        async function forzaCalibrazioneLive() {
            if (!confirm("Desideri ricalcolare ora le soglie operative di oggi per tutti i campionati? L'operazione avverrà in background.")) return;
            try {
                const res = await fetch('/run-live');
                const dati = await res.json();
                alert(dati.status);
            } catch (err) {
                alert("Errore nell'avvio della calibrazione: " + err.message);
            }
        }
    </script>
</body>
</html>
  `;
}