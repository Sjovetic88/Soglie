/**
 * CLOUDFLARE WORKER: SOGLIE & BACKTEST UNIFICATO
 * 
 * Legge da: DB_PRONOSTICI (pronostici_partite)
 * Scrive in: DB_SOGLIE (soglie_campionati)
 */

export default {
  // 1. ENTRY POINT: Esecuzione tramite HTTP (Backtest o Calibrazione Live Manuale)
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);
      const path = url.pathname;

      if (path === "/backtest") {
        const campionato = url.searchParams.get("campionato");
        if (!campionato) {
          return new Response(JSON.stringify({ error: "Parametro 'campionato' mancante" }), {
            status: 400,
            headers: { "Content-Type": "application/json" }
          });
        }
        
        const report = await eseguiBacktestStorico(campionato, env);
        return new Response(JSON.stringify(report, null, 2), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      }

      // Endpoint di utilità per forzare l'allineamento manuale delle soglie di oggi
      if (path === "/run-live") {
        await eseguiCalibrazioneLiveTuttiCampionati(env);
        return new Response(JSON.stringify({ status: "Calibrazione live completata con successo" }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      }

      return new Response(JSON.stringify({ error: "Endpoint non trovato. Usa /backtest?campionato=NomeCampionato" }), {
        status: 404,
        headers: { "Content-Type": "application/json" }
      });

    } catch (error) {
      return new Response(JSON.stringify({ error: error.message, stack: error.stack }), {
        status: 500,
        headers: { "Content-Type": "application/json" }
      });
    }
  },

  // 2. ENTRY POINT: Esecuzione automatica notturna alle 00:00
  async scheduled(event, env, ctx) {
    console.log("Inizio calibrazione notturna automatica...");
    ctx.waitUntil(eseguiCalibrazioneLiveTuttiCampionati(env));
  }
};

// ==========================================
// FUNZIONI PRINCIPALI DI FLUSSO
// ==========================================

/**
 * Identifica tutti i campionati attivi ed esegue l'aggiornamento delle soglie per la giornata corrente.
 */
async function eseguiCalibrazioneLiveTuttiCampionati(env) {
  // Estrae l'elenco dei campionati unici direttamente dal database pronostici
  const queryCampionati = `SELECT DISTINCT campionato FROM validazione_risultati WHERE campionato IS NOT NULL;`;
  const { results } = await env.DB_PRONOSTICI.prepare(queryCampionati).all();
  
  const oggiYMD = ottieniDataOggiYMD();
  console.log(`Calibrazione live in corso per il giorno: ${oggiYMD}`);

  for (const row of results) {
    const campionato = row.campionato;
    try {
      console.log(`Elaborazione live per: ${campionato}`);
      // Carica lo storico degli ultimi 1000 giorni rispetto ad oggi
      const partiteStoriche = await caricaPartiteStoriche(campionato, oggiYMD, 1000, env);
      
      if (partiteStoriche.length < 50) {
        console.log(`Dati insufficienti (${partiteStoriche.length} match) per calibrare ${campionato}. Salto.`);
        continue;
      }

      // Esegue la ricerca a griglia in memoria
      const calibrazioneOttimale = calibraInMemoria(partiteStoriche);

      // Scrive il risultato finale nella tabella delle soglie attive del database dedicato
      await salvaSogliaAttiva(campionato, oggiYMD, calibrazioneOttimale.soglie, env);
      
      // Salva anche nella cache giornaliera storica per uso futuro del backtest
      await cacheCalibrazioneGiornaliera(campionato, oggiYMD, calibrazioneOttimale, env);

    } catch (err) {
      console.error(`Errore durante l'elaborazione del campionato ${campionato}:`, err);
    }
  }
}

/**
 * Esegue una simulazione storica passo-passo per valutare la precisione reale del modello.
 */
async function eseguiBacktestStorico(campionato, env) {
  // Carica tutte le partite storiche del campionato selezionato ordinandole cronologicamente
  const queryTuttiMatch = `
    SELECT * FROM validazione_risultati 
    WHERE campionato = ? AND date IS NOT NULL AND fthg IS NOT NULL AND ftag IS NOT NULL
    ORDER BY date ASC;
  `;
  const { results: tuttiMatch } = await env.DB_PRONOSTICI.prepare(queryTuttiMatch).bind(campionato).all();

  if (tuttiMatch.length < 150) {
    return { campionato, errore: "Dati storici insufficienti per eseguire un backtest significativo." };
  }

  // Carichiamo la cache esistente delle calibrazioni per evitare di rieseguire la Grid Search sui giorni già calcolati
  const cacheCalibrazioni = await caricaCacheCalibrazioni(campionato, env);

  // Mappa per un accesso rapido alla cache O(1)
  const mappaCache = new Map();
  for (const c of cacheCalibrazioni) {
    mappaCache.set(c.date_calibrazione, c);
  }

  const reportMercati = inizializzaStrutturaReport();
  let totaleGiornateCalcolate = 0;
  let queryBatchScrittura = [];

  // Avviamo la simulazione giorno per giorno. 
  // Saltiamo i primi 1000 giorni di storico che servono come "carburante" per la prima calibrazione priva di look-ahead bias.
  const dateUniche = [...new Set(tuttiMatch.map(m => m.date))].sort();
  const primaDataSimulabileIdx = trovaIndicePrimaDataUtile(dateUniche, tuttiMatch, 1000);

  if (primaDataSimulabileIdx === -1 || primaDataSimulabileIdx >= dateUniche.length) {
    return { campionato, errore: "Impossibile accumulare 1000 giorni di storico iniziale per la calibrazione." };
  }

  for (let i = primaDataSimulabileIdx; i < dateUniche.length; i++) {
    const dataCorrente = dateUniche[i];
    
    // Controlliamo se la calibrazione per questa giornata è già presente in cache
    let soglieGiornata = null;
    if (mappaCache.has(dataCorrente)) {
      soglieGiornata = mappaCache.get(dataCorrente);
    } else {
      // Se manca la cache, estraiamo i 1000 giorni precedenti in memoria e facciamo la calibrazione reale
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

        // Accodiamo la nuova calibrazione per scriverla in batch nel DB a fine processo
        queryBatchScrittura.push(preparaQuerySalvataggioCache(soglieGiornata, env));
      }
    }

    if (!soglieGiornata) continue;
    totaleGiornateCalcolate++;

    // Prendiamo i match giocati esattamente in questo giorno corrente per valutarne l'esito reale rispetto alle soglie
    const matchDelGiorno = tuttiMatch.filter(m => m.date === dataCorrente);
    for (const match of matchDelGiorno) {
      valutaMatchRispettoAlleSoglie(match, soglieGiornata, reportMercati);
    }
  }

  // Salviamo in blocco tutte le nuove calibrazioni calcolate in questa sessione per velocizzare i prossimi backtest
  if (queryBatchScrittura.length > 0) {
    // Cloudflare D1 permette di eseguire un array di istruzioni SQL preparate in un'unica transazione (Batch)
    await env.DB_SOGLIE.batch(queryBatchScrittura);
  }

  // Calcolo delle metriche riassuntive finali
  return generaRiepilogoFinalizzato(campionato, tuttiMatch.length, totaleGiornateCalcolate, reportMercati);
}

// ==========================================
// CORE MATEMATICO: GRID SEARCH & CALIBRAZIONE
// ==========================================

const LISTA_MERCATI = [
  "1", "X", "2", "gg", "ng",
  "u05", "o05", "u15", "o15", "u25", "o25", "u35", "o35", "u45", "o45",
  "sg0", "sg1", "sg2", "sg3", "sg4", "sg5", "sg6p"
];

const PARAM_FINESTRE = [365, 500, 730, 1000];
const PARAM_RAGGI = [1, 2, 3];
const PARAM_PENALITA = [4, 6, 8, 10, 12, 14];

/**
 * Esegue l'ottimizzazione a 72 scenari in RAM massimizzando l'efficacia del modello.
 */
function calibraInMemoria(partiteStoriche) {
  let migliorConfigurazione = {
    finestra_giorni: 1000,
    raggio_smussamento: 2,
    penale_applicata: 6,
    punteggio_ottimalita: -1,
    soglie: {}
  };

  // Pre-calcolo degli esiti reali di tutte le partite storiche per non ripeterli all'interno del loop massivo della griglia
  const partiteConEsito = partiteStoriche.map(m => ({
    ...m,
    esitiReali: calcolaMappaEsitiReali(m.fthg, m.ftag)
  }));

  // GRID SEARCH sui 72 scenari parametrici
  for (const finestra of PARAM_FINESTRE) {
    // Filtriamo i match utili per questa finestra specifica
    const dataLimite = calcolaDataMenoGiorni(partiteConEsito[partiteConEsito.length - 1].date, finestra);
    const matchFiltrati = partiteConEsito.filter(m => m.date >= dataLimite);

    if (matchFiltrati.length < 30) continue;

    for (const raggio of PARAM_RAGGI) {
      for (const penale of PARAM_PENALITA) {
        
        const soglieCalcolate = {};
        let sommaPrecisioniSoglie = 0;
        let conteggioMercatiValidi = 0;

        // Ottimizziamo individualmente ciascuno dei 22 mercati in parallelo
        for (const mercato of LISTA_MERCATI) {
          const bs = calcolaBrierScorePerMercato(matchFiltrati, mercato);
          let semaforo = "VERDE";

          if (bs >= 0.72) {
            semaforo = "ROSSO";
          } else if (bs >= 0.68) {
            semaforo = "GIALLO";
          }

          if (semaforo === "ROSSO") {
            soglieCalcolate[mercato] = 100.0; // Blocca totalmente le scommesse impostando la soglia al 100%
          } else {
            const sogliaStandard = trovaMiglioreSogliaSmussata(matchFiltrati, mercato, raggio);
            let sogliaAttiva = sogliaStandard;

            if (semaforo === "GIALLO") {
              sogliaAttiva = Math.min(100.0, sogliaStandard + penale);
            }
            soglieCalcolate[mercato] = sogliaAttiva;

            // Valutiamo la bontà della soglia sul campione di calibrazione
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

  // Se la ricerca non ha prodotto risultati ideali, restituiamo un profilo di default prudente
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

/**
 * Calcola il Brier Score reale per un mercato specifico in un array di match storici.
 * BS = (1/N) * Somma((Probabilità_Stimata - Esito_Reale)^2)
 */
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

/**
 * Trova la soglia standard ideale tra il 45% e l'80% applicando lo smoothing del vicinato.
 */
function trovaMiglioreSogliaSmussata(matchList, mercato, raggio) {
  const precisioniSoglie = {};

  // Calcolo della precisione grezza per ogni soglia dal 40% all'85% (lasciamo margine per lo smoothing)
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

  let miglioreSogliaStandard = 65; // Valore di salvaguardia predefinito
  let mediaVicinatoMigliore = -1;

  // Applichiamo la regola dello smussamento (Smoothing) solo nell'intervallo operativo [45%, 80%]
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

/**
 * Valuta l'accuratezza sul campione storico di calibrazione di una specifica soglia attiva.
 */
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

/**
 * Mappa l'esito calcistico reale (0 o 1) per tutti i 22 mercati.
 */
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
// FUNZIONI DI SUPPORTO E DI ELABORAZIONE DATI
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

// ==========================================
// UTILITY LOGICHE E TEMPORALI
// ==========================================

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