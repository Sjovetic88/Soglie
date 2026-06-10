// ==========================================
// COSTANTI E CONFIGURAZIONI GLOBALIS
// ==========================================
const LISTA_MERCATI = [
  "1", "X", "2", "gg", "ng",
  "u05", "o05", "u15", "o15", "u25", "o25", "u35", "o35", "u45", "o45",
  "sg0", "sg1", "sg2", "sg3", "sg4", "sg5", "sg6p"
];

const PARAM_FINESTRE = [365, 500, 730, 1000];
const PARAM_RAGGI = [1, 2, 3];
const PARAM_PENALITA = [4, 6, 8, 10, 12, 14];

// ==========================================
// FUNZIONI DI ASSISTENZA MATEMATICA E TEMPO
// ==========================================

function formattaDataMMDDYYYY(dataStr) {
  if (!dataStr || dataStr === "-") return "-";
  const parti = dataStr.split("-");
  if (parti.length !== 3) return dataStr;
  return parti[1] + "-" + parti[2] + "-" + parti[0]; // Restituisce MM-DD-YYYY
}

function ottieniDataOggiYMD() {
  const d = new Date();
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return year + "-" + month + "-" + day;
}

function calcolaDataMenoGiorni(dataRiferimentoYMD, giorni) {
  const d = new Date(dataRiferimentoYMD);
  d.setDate(d.getDate() - giorni);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return year + "-" + month + "-" + day;
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
    
    // OTTIMIZZATO: Confronto diretto di stringhe
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
// METODI INTERFACCIAMENTO D1 DATABASE
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

// CORRETTO: Sostituito stroke_u15 con soglia_u15 per allineamento D1
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

// CORRETTO E COERENTE: CHIAMATO SEMPRE CON "caricaCacheCalibrazioni"
async function caricaCacheCalibrazioni(campionato, env) {
  const query = `SELECT * FROM calibrazioni_giornaliere WHERE campionato = ?;`;
  const { results } = await env.DB_SOGLIE.prepare(query).bind(campionato).all();
  return results;
}

// ==========================================
// ALGORITMO DI BACKTEST & STREAMING (SSE)
// ==========================================

async function eseguiBacktestInStreaming(campionato, env, writer, encoder) {
  // OTTIMIZZATO RAM: Carichiamo solo ed esclusivamente le colonne necessarie alle operazioni matematiche
  const queryTuttiMatch = `
    SELECT date, home_team, away_team, fthg, ftag,
           prob_1, prob_X, prob_2, prob_gg, prob_ng,
           prob_u05, prob_o05, prob_u15, prob_o15, prob_u25, prob_o25,
           prob_u35, prob_o35, prob_u45, prob_o45,
           prob_sg0, prob_sg1, prob_sg2, prob_sg3, prob_sg4, prob_sg5, prob_sg6p
    FROM validazione_risultati 
    WHERE campionato = ? AND date IS NOT NULL AND fthg IS NOT NULL AND ftag IS NOT NULL
    ORDER BY date ASC;
  `;
  const { results: tuttiMatch } = await env.DB_PRONOSTICI.prepare(queryTuttiMatch).bind(campionato).all();

  if (tuttiMatch.length < 150) {
    const msg = JSON.stringify({ type: "error", message: "Dati storici insufficienti (minimo 150 match)." });
    await writer.write(encoder.encode(`data: ${msg}\n\n`));
    return;
  }

  // FIRMA ALLINEATA SENZA RISCHI DI RIFERIMENTO INESISTENTE
  const cacheCalibrazioni = await caricaCacheCalibrazioni(campionato, env);
  const mappaCache = new Map(cacheCalibrazioni.map(c => [c.date_calibrazione, c]));

  const reportMercati = inizializzaStrutturaReport();
  let totaleGiornateCalcolate = 0;
  let matchesProcessati = 0;
  const totaleMatchesDaSimulare = tuttiMatch.length;
  let queryBatchScrittura = [];

  const dateUniche = [...new Set(tuttiMatch.map(m => m.date))].sort();
  const primaDataSimulabileIdx = trovaIndicePrimaDataUtile(dateUniche, tuttiMatch, 1000);

  if (primaDataSimulabileIdx === -1 || primaDataSimulabileIdx >= dateUniche.length) {
    const msg = JSON.stringify({ type: "error", message: "Storico iniziale 1000 giorni insufficiente." });
    await writer.write(encoder.encode(`data: ${msg}\n\n`));
    return;
  }

  for (let idx = 0; idx < primaDataSimulabileIdx; idx++) {
    const matchesData = tuttiMatch.filter(m => m.date === dateUniche[idx]);
    matchesProcessati += matchesData.length;
  }

  for (let i = primaDataSimulabileIdx; i < dateUniche.length; i++) {
    const dataCorrente = dateUniche[i];
    let soglieGiornata = mappaCache.get(dataCorrente);

    if (!soglieGiornata) {
      const dataLimiteInferiore = calcolaDataMenoGiorni(dataCorrente, 1000);
      
      // OTTIMIZZATO: Utilizziamo il confronto diretto di stringhe per la data anziché istanziare oggetti Date
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

    // Invio progressi real-time con lo spacchettamento dettagliato del match
    if (matchDelGiorno.length > 0) {
      const matchAttivo = matchDelGiorno[0];
      const percentualeStr = ((matchesProcessati / totaleMatchesDaSimulare) * 100).toFixed(1);
      
      const chunkProgresso = JSON.stringify({
        type: "progress",
        elaborati: matchesProcessati,
        totale: totaleMatchesDaSimulare,
        percentuale: percentualeStr,
        date: matchAttivo.date,
        home: matchAttivo.home_team,
        away: matchAttivo.away_team,
        fthg: matchAttivo.fthg,
        ftag: matchAttivo.ftag
      });

      await writer.write(encoder.encode(`data: ${chunkProgresso}\n\n`));
    }
  }

  if (queryBatchScrittura.length > 0) {
    await env.DB_SOGLIE.batch(queryBatchScrittura);
  }

  const reportRiepilogativo = generaRiepilogoFinalizzato(campionato, totaleMatchesDaSimulare, totaleGiornateCalcolate, reportMercati);
  const chunkFinale = JSON.stringify({
    type: "complete",
    report: reportRiepilogativo,
    soglie_attive: queryBatchScrittura.length > 0 ? queryBatchScrittura[queryBatchScrittura.length - 1] : null
  });

  await writer.write(encoder.encode(`data: ${chunkFinale}\n\n`));
}

// ==========================================
// RENDERING INTERFACCIA HTML (GOLDBET)
// ==========================================

function ottieniHTMLDashboardEngineCompleto() {
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
            background-color: #0a0a0c;
            border: 1px solid #1c1c1e;
        }
        .neon-cyan {
            color: #00e5ff;
            text-shadow: 0 0 10px rgba(0, 229, 255, 0.2);
        }
        .glow-border {
            border-color: #00e5ff !important;
            box-shadow: 0 0 15px rgba(0, 229, 255, 0.25);
        }
        .bottom-nav {
            background-color: #000000;
            border-top: 1px solid #1c1c1e;
        }
        .progress-bar-fill {
            background-color: #00e5ff;
            box-shadow: 0 0 8px #00e5ff;
            transition: width 0.1s linear;
        }
        .no-scrollbar::-webkit-scrollbar { display: none; }
        .no-scrollbar { -ms-overflow-style: none; scrollbar-width: none; }
    </style>
</head>
<body class="overflow-x-hidden min-h-screen pb-24">

    <!-- INTESTAZIONE LOGO ENGINE CON LED DI STATO MINIMALE (8PX) -->
    <header class="text-center py-6 mt-2">
        <h1 class="text-2xl font-black uppercase tracking-wider mb-0.5 inline-flex items-center gap-2">
            GOLDBET <span class="neon-cyan">SOGLIE</span>
            <span id="header-status-dot" class="h-2 w-2 rounded-full bg-amber-500 animate-pulse shadow-[0_0_8px_#f59e0b]"></span>
        </h1>
        <div id="stat-allineamento-globale" class="text-[9px] text-zinc-500 font-bold uppercase tracking-widest mt-1">
            ULTIMA ELABORAZIONE: -
        </div>
    </header>

    <!-- CONTENITORE CENTRALE -->
    <main class="max-w-md mx-auto px-4 mt-2">

        <!-- TAB 1: HOME (CON SELEZIONE E INTEGRAZIONE PROGRESSO INTERNO) -->
        <div id="tab-home" class="space-y-4">
            <div class="flex justify-between items-center px-1">
                <span class="text-xs font-black text-zinc-500 uppercase tracking-widest">Lega / Campionato</span>
                <span id="selezione-counter" class="text-[10px] text-zinc-600 font-bold">0 SELEZIONATI</span>
            </div>

            <!-- Elenco dinamico dei campionati -->
            <div id="lista-campionati-container" class="space-y-3">
                <div class="py-12 text-center text-zinc-600 animate-pulse text-xs uppercase tracking-widest">Caricamento in corso...</div>
            </div>

            <!-- CONSOLE LOG STRUMENTALE PROVVISORIA PER LA DIAGNOSTICA IN TEMPO REALE -->
            <div class="amoled-card rounded-xl p-4 border border-zinc-800 bg-[#050505] mt-6">
                <div class="flex justify-between items-center mb-2 pb-2 border-b border-zinc-900 shrink-0">
                    <span class="text-[9px] font-black uppercase tracking-widest text-cyan-400">Console Log Diagnostica</span>
                    <button onclick="pulisciConsoleLog()" class="text-[8px] text-zinc-600 hover:text-white uppercase font-bold tracking-wider">Cancella</button>
                </div>
                <div id="console-log-box" class="h-28 overflow-y-auto font-mono text-[9px] text-zinc-500 space-y-1 no-scrollbar scroll-smooth">
                    <div>[SYSTEM] Inizializzazione console di tracciamento...</div>
                </div>
            </div>
        </div>

        <!-- TAB 2: SOGLIE LIVE GLOBALI (SFOGLIATORE FISARMONICA) -->
        <div id="tab-soglie" class="hidden space-y-4">
            <div class="flex justify-between items-center px-1 gap-4">
                <span class="text-xs font-black text-zinc-500 uppercase tracking-widest">Cerca Soglie</span>
                <input type="text" id="cerca-soglie-input" oninput="filtraSoglie()" placeholder="Cerca competizione..." class="bg-[#0c0c0e] border border-zinc-800 text-[10px] text-white rounded px-2.5 py-1.5 focus:outline-none focus:border-cyan-400 w-1/2">
            </div>

            <div id="soglie-accordions-container" class="space-y-3">
                <!-- Generato Dinamicamente -->
            </div>
        </div>

    </main>

    <!-- BARRA OPERATIVA INFERIORE -->
    <nav class="fixed bottom-0 left-0 right-0 max-w-md mx-auto z-40 bottom-nav h-16 flex items-center justify-around px-2">
        
        <!-- PULSANTE VISTA HOME -->
        <button id="nav-btn-home" onclick="navigaTab('home')" class="flex flex-col items-center justify-center w-14 h-12 text-cyan-400 transition">
            <svg class="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h3m-6 0a1 1 0 001-1v-4a1 1 0 00-1-1h-3a1 1 0 00-1 1v4a1 1 0 001 1m-6 0h6"></path>
            </svg>
            <span class="text-[8px] font-bold uppercase tracking-wider mt-1">Lega</span>
        </button>

        <!-- PULSANTE VISTA SOGLIE LIVE -->
        <button id="nav-btn-soglie" onclick="navigaTab('soglie')" class="flex flex-col items-center justify-center w-14 h-12 text-zinc-500 hover:text-white transition">
            <svg class="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-3 7h3m-3 4h3m-6-4h.01M9 16h.01"></path>
            </svg>
            <span class="text-[8px] font-bold uppercase tracking-wider mt-1">Soglie Live</span>
        </button>

        <!-- TASTO CENTRALE AVVIA (SELEZIONE IN HOME) -->
        <button id="btn-global-avvia" onclick="avviaCalcoloSelezionati()" disabled class="flex flex-col items-center justify-center w-16 h-16 bg-gradient-to-b from-zinc-900 to-black border border-zinc-800 rounded-full text-zinc-600 cursor-not-allowed shadow-lg -translate-y-3 transition duration-200">
            <svg class="h-6 w-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z"></path>
            </svg>
        </button>

        <!-- TASTO NITRO (PERSISTENT TOGGLE PER LA VELOCITÀ MASSIMA IN PARALLELO) -->
        <button id="nav-btn-nitro" onclick="togglaNitroMode()" class="flex flex-col items-center justify-center w-14 h-12 text-zinc-500 hover:text-orange-400 transition">
            <svg class="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 10V3L4 14h7v7l9-11h-7z"></path>
            </svg>
            <span class="text-[8px] font-bold uppercase tracking-wider mt-1" id="nitro-txt">Nitro Off</span>
        </button>

        <!-- TASTO RESET COMPLETO -->
        <button onclick="resetGeneraleEngine()" class="flex flex-col items-center justify-center w-14 h-12 text-zinc-500 hover:text-red-500 transition">
            <svg class="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path>
            </svg>
            <span class="text-[8px] font-bold uppercase tracking-wider mt-1">Reset</span>
        </button>

    </nav>

    <!-- CODICE INTERATTIVO JAVASCRIPT FRONTEND -->
    <script>
        let campionati = [];
        let campionatiSelezionati = [];
        let datiSoglieOperative = [];
        let backtestResults = {}; 
        let currentSseConnection = null;
        let isProcessingInCorso = false;
        let isNitroModeAttiva = false; // Stato della Nitro Mode parallela

        window.addEventListener('DOMContentLoaded', () => {
            aggiungiLog("Inizializzazione Goldbet Soglie Dashboard...", "info");
            eseguiDiagnosticaIniziale();
            caricaCampionatiHome();
            caricaSoglieLiveFisarmonica();
        });

        // FUNZIONE DEDICATA PER IL LOG STRUMENTALE IN TEMPO REALE
        function aggiungiLog(msg, tipo) {
            const box = document.getElementById('console-log-box');
            if (!box) return;
            const now = new Date();
            const timeStr = String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0') + ':' + String(now.getSeconds()).padStart(2, '0');
            
            const div = document.createElement('div');
            let colorClass = 'text-zinc-500';
            if (tipo === 'success') colorClass = 'text-emerald-400 font-bold';
            if (tipo === 'error') colorClass = 'text-red-500 font-bold';
            if (tipo === 'warning') colorClass = 'text-amber-500';
            if (tipo === 'process') colorClass = 'text-cyan-400 animate-pulse';

            div.className = colorClass;
            div.innerHTML = '[' + timeStr + '] ' + msg;
            box.appendChild(div);
            box.scrollTop = box.scrollHeight; // Auto scroll
        }

        function pulisciConsoleLog() {
            const box = document.getElementById('console-log-box');
            if (box) box.innerHTML = '<div>[SYSTEM] Console ripulita. In attesa di istruzioni...</div>';
        }

        // 1. FUNZIONE DIAGNOSTICA PROATTIVA CON ACCENSIONE LED MINIMALE (8PX)
        async function eseguiDiagnosticaIniziale() {
            const led = document.getElementById('header-status-dot');
            const sub = document.getElementById('stat-allineamento-globale');
            aggiungiLog("Verifica connessione D1 e integrità tabelle...", "info");
            try {
                const res = await fetch('/api/diagnostica');
                if (!res.ok) {
                    const errData = await res.json().catch(() => ({}));
                    throw new Error(errData.messaggio || errData.error || ('HTTP Status ' + res.status));
                }
                const diagnostica = await res.json();
                if (diagnostica.status === "OK") {
                    led.className = "h-2 w-2 rounded-full bg-emerald-500 animate-pulse shadow-[0_0_8px_#10b981]";
                    aggiungiLog("Diagnostica superata! Connessione database D1 stabile.", "success");
                } else {
                    throw new Error(diagnostica.messaggio || "Errore sconosciuto");
                }
            } catch (err) {
                mostraErroreDiagnostica(err.message);
            }
        }

        function mostraErroreDiagnostica(msg) {
            const led = document.getElementById('header-status-dot');
            const sub = document.getElementById('stat-allineamento-globale');
            
            led.className = "h-2 w-2 rounded-full bg-red-500 animate-pulse shadow-[0_0_8px_#ef4444]";
            sub.className = "text-[9px] text-red-500 font-bold uppercase tracking-widest mt-1 px-4";
            sub.textContent = "✖ ERRORE CONNESSIONE D1: " + msg.toUpperCase();
            
            aggiungiLog("DIAGNOSTICA KO: " + msg, "error");
        }

        // 2. RENDERING LISTA CAMPIONATI (HOME TAB)
        async function caricaCampionatiHome() {
            const container = document.getElementById('lista-campionati-container');
            aggiungiLog("Estrazione campionati dal database pronostici...", "info");
            try {
                const res = await fetch('/api/campionati');
                if (!res.ok) {
                    const errData = await res.json().catch(() => ({}));
                    throw new Error(errData.error || ('D1 SQLite Errore Status ' + res.status));
                }
                const payload = await res.json();
                campionati = payload.campionati;
                
                // Aggiorna l'ora dell'ultima elaborazione globale nell'header
                const subHeader = document.getElementById('stat-allineamento-globale');
                if (payload.ultima_elaborazione_globale && payload.ultima_elaborazione_globale !== "-") {
                    subHeader.textContent = "ULTIMA ELABORAZIONE: " + formattaDataMMDDYYYY_conOra(payload.ultima_elaborazione_globale);
                } else {
                    subHeader.textContent = "ULTIMA ELABORAZIONE: NESSUN DATO REGISTRATO";
                }

                aggiungiLog("Caricati " + campionati.length + " campionati attivi dal database.", "success");

                container.innerHTML = '';
                campionati.forEach(item => {
                    const card = document.createElement('div');
                    const cleanId = pulisciId(item.campionato);
                    card.id = 'card-' + cleanId;
                    card.className = "amoled-card rounded-xl p-4 transition duration-200 cursor-pointer select-none flex flex-col gap-2";
                    
                    card.onclick = (e) => {
                        if (isProcessingInCorso) return;
                        if (e.target.closest('.dettagli-backtest-box')) return;
                        if (e.target.closest('.progresso-inline-box')) return;
                        togglaSelezioneCampionato(item.campionato);
                    };

                    const badgeColore = item.aggiornato ? "text-emerald-400 bg-emerald-950/40" : "text-zinc-600 bg-zinc-950/40";
                    const badgeTesto = item.aggiornato ? "CALIBRATO" : "IN ATTESA";

                    // Formattazione staticamente dell'ultimo match nel formato richiesto
                    const dataInizialeFmt = formattaDataMMDDYYYY(item.ultimo_match_data);
                    const homeTeamFmt = item.ultimo_match_home.toUpperCase();
                    const awayTeamFmt = item.ultimo_match_away.toUpperCase();
                    const scoreFmt = item.ultimo_match_fthg + '-' + item.ultimo_match_ftag;
                    const rigaDettaglioMatch = '📆 ' + dataInizialeFmt + ' | ' + homeTeamFmt + ' - ' + awayTeamFmt + ' ' + scoreFmt;

                    card.innerHTML = 
                        '<div class="flex justify-between items-center shrink-0">' +
                            '<div>' +
                                '<h3 class="text-sm font-black uppercase text-white tracking-wide font-semibold flex items-center gap-2">' +
                                    '<span id="select-indicator-' + cleanId + '" class="hidden text-[#00e5ff] text-xs">●</span>' +
                                    item.campionato +
                                '</h3>' +
                                '<p class="text-[9px] text-zinc-500 font-bold uppercase tracking-wider mt-0.5" id="desc-' + cleanId + '" data-original="' + rigaDettaglioMatch + '">' +
                                    rigaDettaglioMatch +
                                '</p>' +
                            '</div>' +
                            '<div>' +
                                '<span id="badge-' + cleanId + '" class="text-[8px] font-black px-2 py-0.5 rounded ' + badgeColore + ' tracking-widest uppercase">' +
                                    badgeTesto +
                                '</span>' +
                            '</div>' +
                        '</div>' +

                        '<!-- MICRO PANNELLO PROGRESSO IN LINEA (NASCOSTO DI BASE) -->' +
                        '<div id="progresso-box-' + cleanId + '" onclick="event.stopPropagation()" class="progresso-inline-box hidden border-t border-zinc-900 pt-3 mt-2 space-y-1.5">' +
                            '<div class="flex justify-between items-center text-[8px] uppercase tracking-wider font-bold">' +
                                '<span class="text-zinc-500">Avanzamento Simulazione</span>' +
                                '<span id="progresso-txt-' + cleanId + '" class="neon-cyan">0.0%</span>' +
                            '</div>' +
                            '<div class="w-full bg-zinc-950 h-1.5 rounded-full overflow-hidden border border-zinc-900">' +
                                '<div id="progresso-bar-' + cleanId + '" class="h-full progress-bar-fill" style="width: 0%"></div>' +
                            '</div>' +
                        '</div>' +

                        '<!-- FISARMONICA RISULTATI POST-CALCOLO (ACCORDION INTERNO ALLA CARD) -->' +
                        '<div id="dettagli-box-' + cleanId + '" onclick="event.stopPropagation()" class="dettagli-backtest-box hidden border-t border-zinc-900 pt-3 mt-3 space-y-3">' +
                            '<div class="grid grid-cols-2 gap-2 text-center">' +
                                '<div class="bg-black p-2 rounded border border-zinc-900">' +
                                    '<span class="text-[8px] text-zinc-500 block uppercase font-bold">Segnalate</span>' +
                                    '<span id="det-consigliate-' + cleanId + '" class="text-xs font-black text-emerald-400">-</span>' +
                                    '</div>' +
                                '<div class="bg-black p-2 rounded border border-zinc-900">' +
                                    '<span class="text-[8px] text-zinc-500 block uppercase font-bold">Precisione</span>' +
                                    '<span id="det-precisione-' + cleanId + '" class="text-xs font-black text-cyan-400">-</span>' +
                                '</div>' +
                            '</div>' +
                            
                            '<!-- Griglia mini a comparsa dei 22 mercati -->' +
                            '<div id="det-griglia-' + cleanId + '" class="grid grid-cols-3 gap-1.5 pt-1">' +
                                '<!-- Generato istantaneamente -->' +
                            '</div>' +
                        '</div>';
                    
                    container.appendChild(card);
                });
            } catch (err) {
                container.innerHTML = 
                    '<div class="text-center py-10 text-red-500 text-xs font-bold uppercase">' +
                        'ERRORE DI CARICAMENTO CAMPIONATI:<br>' +
                        '<span class="text-gray-400 text-[10px] lowercase font-normal block mt-2 px-4">' + err.message + '</span>' +
                    '</div>';
                aggiungiLog("Caricamento campionati fallito: " + err.message, "error");
            }
        }

        // Toggles selection on cards
        function togglaSelezioneCampionato(campionato) {
            const cleanId = pulisciId(campionato);
            const idx = campionatiSelezionati.indexOf(campionato);
            const cardId = 'card-' + cleanId;
            const indicatorId = 'select-indicator-' + cleanId;
            
            const card = document.getElementById(cardId);
            const indicator = document.getElementById(indicatorId);

            if (idx === -1) {
                campionatiSelezionati.push(campionato);
                if (card) card.classList.add('glow-border');
                if (indicator) indicator.classList.remove('hidden');
                aggiungiLog("Selezionato campionato: " + campionato, "info");
            } else {
                campionatiSelezionati.splice(idx, 1);
                if (card) card.classList.remove('glow-border');
                if (indicator) indicator.classList.add('hidden');
                aggiungiLog("Deselezionato campionato: " + campionato, "warning");
            }

            aggiornaBottoneAvvioSoglie();
        }

        function aggiornaBottoneAvvioSoglie() {
            const btn = document.getElementById('btn-global-avvia');
            const countLabel = document.getElementById('selezione-counter');

            countLabel.textContent = campionatiSelezionati.length + ' SELEZIONATI';

            if (campionatiSelezionati.length > 0) {
                btn.disabled = false;
                btn.className = "flex flex-col items-center justify-center w-16 h-16 bg-gradient-to-b from-[#121212] to-[#000] border border-[#00e5ff]/50 rounded-full text-cyan-400 shadow-[0_0_15px_rgba(0,229,255,0.3)] cursor-pointer -translate-y-3 transition duration-200 hover:border-[#00e5ff] hover:shadow-[0_0_20px_rgba(0,229,255,0.4)]";
            } else {
                btn.disabled = true;
                btn.className = "flex flex-col items-center justify-center w-16 h-16 bg-gradient-to-b from-zinc-900 to-black border border-zinc-800 rounded-full text-zinc-600 cursor-not-allowed shadow-lg -translate-y-3 transition duration-200";
            }
        }

        // TOGGLE PER ATTIVARE/DISATTIVARE LA NITRO MODE PARALLELA
        function togglaNitroMode() {
            const btn = document.getElementById('nav-btn-nitro');
            const txt = document.getElementById('nitro-txt');

            isNitroModeAttiva = !isNitroModeAttiva;

            if (isNitroModeAttiva) {
                txt.textContent = "Nitro On";
                btn.className = "flex flex-col items-center justify-center w-14 h-12 text-orange-400 transition shadow-[0_0_12px_rgba(251,146,60,0.25)]";
                aggiungiLog("Nitro Mode ATTIVATA. L'elaborazione avverrà in parallelo sui canali dedicati.", "warning");
            } else {
                txt.textContent = "Nitro Off";
                btn.className = "flex flex-col items-center justify-center w-14 h-12 text-zinc-500 hover:text-orange-400 transition";
                aggiungiLog("Nitro Mode disattivata. Elaborazione impostata in sequenziale.", "info");
            }
        }

        // 3. AVVIO MOTORE: SEQUENZIALE (STANDARD) OPPURE PARALLELO ULTRA-VELOCE (NITRO MODE ON)
        async function avviaCalcoloSelezionati() {
            if (campionatiSelezionati.length === 0) return;

            const campionatiDaElaborare = [...campionatiSelezionati];
            aggiungiLog("Avvio elaborazione per campionati: " + campionatiDaElaborare.join(', '), "process");
            
            // UI LOCK: impediamo click estranei durante il processo
            isProcessingInCorso = true;
            disabilitaInterfacciaCompletamente(true);

            if (isNitroModeAttiva) {
                // VERA NITRO MODE: Calcolo asincrono di tutti i campionati in parallelo!
                aggiungiLog("Invio richieste asincrone parallele di calcolo...", "process");
                const promesseCalcolo = campionatiDaElaborare.map(camp => elaboraCampionatoInStreaming(camp));
                await Promise.all(promesseCalcolo);
            } else {
                // MODALITÀ STANDARD: Calcolo sequenziale (uno alla volta)
                for (const camp of campionatiDaElaborare) {
                    aggiungiLog("Avvio analisi sequenziale per: " + camp, "process");
                    await elaboraCampionatoInStreaming(camp);
                }
            }

            isProcessingInCorso = false;
            disabilitaInterfacciaCompletamente(false);
            campionatiSelezionati = [];
            aggiornaBottoneAvvioSoglie();
            await caricaSoglieLiveFisarmonica(); // Rinfresca il visualizzatore globale
            aggiungiLog("Elaborazione completata. Rilasciato lock sui controlli.", "success");
        }

        function elaboraCampionatoInStreaming(campionato) {
            return new Promise((resolve) => {
                const idCamp = pulisciId(campionato);
                aggiungiLog("Apertura canale streaming SSE per: " + campionato, "info");
                
                // Espande ed attiva la barra di progresso
                document.getElementById('progresso-box-' + idCamp).classList.remove('hidden');
                document.getElementById('dettagli-box-' + idCamp).classList.add('hidden'); // Chiude accordion vecchi

                // Avvia connessione SSE dedicata
                let connection = new EventSource('/backtest?campionato=' + encodeURIComponent(campionato));

                connection.onmessage = function(event) {
                    const data = JSON.parse(event.data);

                    if (data.type === "progress") {
                        // 1. Aggiorna percentuale numerica e barra
                        document.getElementById('progresso-txt-' + idCamp).textContent = data.percentuale + "%";
                        document.getElementById('progresso-bar-' + idCamp).style.width = data.percentuale + "%";
                        
                        // 2. TIMELINE TICKER: Formatta la riga descrittiva sotto il campionato in tempo reale
                        const dataFmt = formattaDataMMDDYYYY(data.date);
                        const homeFmt = data.home.toUpperCase();
                        const awayFmt = data.away.toUpperCase();
                        const scoreFmt = data.fthg + '-' + data.ftag;
                        
                        const rigaCorrente = '📆 ' + dataFmt + ' | ' + homeFmt + ' - ' + awayFmt + ' ' + scoreFmt;
                        document.getElementById('desc-' + idCamp).textContent = rigaCorrente;
                        
                        // Scriviamo l'avanzamento anche nella nostra console di log strumentale
                        aggiungiLog("[" + campionato + "] Progresso: " + data.percentuale + "% (" + rigaCorrente + ")", "info");
                    } 
                    
                    else if (data.type === "complete") {
                        connection.close();
                        aggiungiLog("Canale completato ed elaborato con successo per: " + campionato, "success");
                        
                        // Nascondi barra progresso, aggiorna badge in 100.0% e popola accordion interno
                        document.getElementById('progresso-box-' + idCamp).classList.add('hidden');
                        
                        const badge = document.getElementById('badge-' + idCamp);
                        badge.className = "text-[8px] font-black px-2 py-0.5 rounded text-emerald-400 bg-emerald-950/40 tracking-widest uppercase";
                        badge.textContent = "100.0%"; // Mostra il 100% come nello screenshot

                        // Ripristina la riga descrittiva all'ultimo match statico registrato
                        const desc = document.getElementById('desc-' + idCamp);
                        desc.textContent = desc.dataset.original;

                        visualizzaDettagliRisultatiCard(campionato, data.report);
                        resolve();
                    } 
                    
                    else if (data.type === "error") {
                        connection.close();
                        aggiungiLog("ERRORE DI ELABORAZIONE SERVER (" + campionato + "): " + data.message, "error");
                        alert("ERRORE SUL SERVER: Il Worker ha riscontrato anomalie sul campionato " + campionato + "\\n\\nDettaglio: " + data.message);
                        document.getElementById('progresso-box-' + idCamp).classList.add('hidden');
                        
                        const desc = document.getElementById('desc-' + idCamp);
                        desc.textContent = desc.dataset.original;
                        resolve();
                    }
                };

                // GESTIONE DIAGNOSTICA COMPLETA SENZA CHIUSURE SILENZIOSE
                connection.onerror = async function() {
                    connection.close();
                    
                    // Se l'elaborazione è stata già memorizzata dal thread complete prima dell'error, usciamo lisci
                    if (backtestResults[campionato]) {
                        resolve();
                        return;
                    }

                    aggiungiLog("Inizio recupero dettagli errore di connessione streaming per: " + campionato, "warning");
                    
                    document.getElementById('progresso-box-' + idCamp).classList.add('hidden');
                    const desc = document.getElementById('desc-' + idCamp);
                    desc.textContent = desc.dataset.original;

                    // Recupera l'errore SQL formattato inviato dal Worker tramite Pre-flight
                    try {
                        const errRes = await fetch('/backtest?campionato=' + encodeURIComponent(campionato));
                        if (!errRes.ok) {
                            const errData = await errRes.json().catch(() => ({}));
                            const msgErrore = errData.error || errData.message || "Errore sconosciuto.";
                            aggiungiLog("STREAMING KO (" + campionato + "): " + msgErrore, "error");
                            alert("✖ ERRORE DI ELABORAZIONE (" + campionato + ")\\n\\n" + msgErrore);
                        } else {
                            aggiungiLog("STREAMING KO (" + campionato + "): Connessione chiusa prima della trasmissione dati.", "error");
                            alert("✖ ERRORE DI CONNESSIONE STREAMING (" + campionato + ")\\n\\nLa chiamata è stata interrotta senza restituire dati.");
                        }
                    } catch (e) {
                        aggiungiLog("STREAMING KO (" + campionato + "): Errore di connessione.", "error");
                        alert("✖ ERRORE DI RETE (" + campionato + ")\\n\\nImpossibile connettersi al Worker.");
                    }
                    resolve();
                };
            });
        }

        function visualizzaDettagliRisultatiCard(campionato, report) {
            const idCamp = pulisciId(campionato);
            
            backtestResults[campionato] = report;

            document.getElementById('det-consigliate-' + idCamp).textContent = report.riepilogo_generale.totale_consigliate;
            document.getElementById('det-precisione-' + idCamp).textContent = report.riepilogo_generale.precisione_media + "%";

            const griglia = document.getElementById('det-griglia-' + idCamp);
            griglia.innerHTML = '';

            Object.keys(report.esiti).forEach(m => {
                const dati = report.esiti[m];
                const item = document.createElement('div');
                item.className = "bg-black p-1 text-center rounded border border-zinc-900";
                
                let coloreTesto = "text-[#00e5ff]";
                if (dati.precisione_percentuale < 55) coloreTesto = "text-red-500";
                else if (dati.precisione_percentuale < 70) coloreTesto = "text-amber-500";

                item.innerHTML = 
                    '<div class="text-[7px] text-zinc-500 font-bold uppercase truncate">' + m + '</div>' +
                    '<div class="text-[9px] font-bold ' + coloreTesto + '">' + dati.precisione_percentuale.toFixed(0) + '%</div>';
                
                griglia.appendChild(item);
            });

            // Espande la fisarmonica interna alla card con i risultati finali
            document.getElementById('dettagli-box-' + idCamp).classList.remove('hidden');
        }

        function disabilitaInterfacciaCompletamente(stato) {
            document.querySelectorAll('button').forEach(b => b.disabled = stato);
            document.getElementById('nav-btn-home').disabled = false;
            document.getElementById('nav-btn-soglie').disabled = false;
            document.getElementById('nav-btn-nitro').disabled = false;
        }

        // 4. SEZIONE: SFOGLIATORE GLOBALE DELLE SOGLIE LIVE (TAB 2)
        async function caricaSoglieLiveFisarmonica() {
            const container = document.getElementById('soglie-accordions-container');
            aggiungiLog("Lettura delle soglie attive da soglie_campionati...", "info");
            try {
                const res = await fetch('/api/tutte-soglie');
                if (!res.ok) {
                    const errData = await res.json().catch(() => ({}));
                    throw new Error(errData.error || ('D1 Status ' + res.status));
                }
                datiSoglieOperative = await res.json();

                if (datiSoglieOperative.length === 0) {
                    container.innerHTML = '<div class="py-12 text-center text-zinc-600 text-xs font-black uppercase">Nessuna soglia calibrata presente nel database.</div>';
                    aggiungiLog("Tabella soglie_attive vuota.", "warning");
                    return;
                }

                renderizzaAccordionSoglie(datiSoglieOperative);
                aggiungiLog("Caricate " + datiSoglieOperative.length + " competizioni calibrate nella tab Soglie Live.", "success");
            } catch (err) {
                container.innerHTML = '<div class="text-center py-10 text-red-500 text-xs font-bold uppercase">ERRORE CARICAMENTO SOGLIE:<br><span class="text-zinc-500 text-[10px] block mt-1 font-normal lowercase">' + err.message + '</span></div>';
                aggiungiLog("Errore caricamento Soglie Live: " + err.message, "error");
            }
        }

        function renderizzaAccordionSoglie(lista) {
            const container = document.getElementById('soglie-accordions-container');
            container.innerHTML = '';

            lista.forEach((item, index) => {
                const el = document.createElement('div');
                el.className = "amoled-card rounded-xl overflow-hidden dynamic-soglia-item";
                el.dataset.campionato = item.campionato.toLowerCase();

                el.innerHTML = 
                    '<!-- Testata fisarmonica -->' +
                    '<button onclick="togglaSezioneFisarmonica(' + index + ')" class="w-full text-left p-4 hover:bg-zinc-950 transition flex justify-between items-center">' +
                        '<div>' +
                            '<span class="text-xs font-black uppercase text-white tracking-wide">' + item.campionato + '</span>' +
                            '<span class="text-[8px] text-zinc-500 font-bold block mt-0.5">AGGIORNATO IL: ' + item.date_aggiornamento + '</span>' +
                        '</div>' +
                        '<svg id="soglie-arrow-' + index + '" class="h-4 w-4 text-zinc-500 transition-transform duration-200" fill="none" stroke="currentColor" viewBox="0 0 24 24">' +
                            '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"></path>' +
                        '</svg>' +
                    '</button>' +
                    '<!-- Corpo soglie -->' +
                    '<div id="soglie-body-' + index + '" class="hidden p-4 border-t border-zinc-900 bg-black grid grid-cols-2 sm:grid-cols-3 gap-2">' +
                        costruisciGriglia22SoglieEngine(item) +
                    '</div>';
                
                container.appendChild(el);
            });
        }

        // Metodo per formattare la data con ora per l'header dinamico
        function formattaDataMMDDYYYY_conOra(dataOraStr) {
            if (!dataOraStr || dataOraStr === "-") return "-";
            var partiSpazio = dataOraStr.split(" ");
            if (partiSpazio.length < 1) return dataOraStr;
            
            var dataParte = partiSpazio[0];
            var oraParte = partiSpazio[1] || "";
            
            var partiData = dataParte.split("-");
            if (partiData.length !== 3) return dataOraStr;
            
            var dataFormattata = partiData[1] + "-" + partiData[2] + "-" + partiData[0];
            return dataFormattata + " " + oraParte;
        }

        function costruisciGriglia22SoglieEngine(item) {
            let html = '';
            const chiaviSoglia = Object.keys(item).filter(k => k.startsWith('soglia_'));

            chiaviSoglia.forEach(key => {
                const nomeMercato = key.replace('soglia_', '').toUpperCase();
                const valore = item[key];
                const bloccato = valore >= 100;
                const classeColore = bloccato ? 'text-red-500' : 'text-cyan-400';
                const dicituraValore = bloccato ? 'BLOCKED' : valore.toFixed(1) + '%';

                html += 
                    '<div class="bg-[#060608] p-2 rounded-lg border border-zinc-950 text-center">' +
                        '<span class="text-[7px] text-zinc-500 font-bold uppercase block">' + nomeMercato + '</span>' +
                        '<span class="text-xs font-black block mt-0.5 ' + classeColore + '">' +
                            dicituraValore +
                        '</span>' +
                    '</div>';
            });
            return html;
        }

        // 5. METODI COMPRESSIONE SERRANDE FISARMONICA
        function togglaSezioneFisarmonica(idx) {
            const body = document.getElementById('soglie-body-' + idx);
            const arrow = document.getElementById('soglie-arrow-' + idx);

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

        function filtraSoglie() {
            const query = document.getElementById('cerca-soglie-input').value.toLowerCase();
            const items = document.querySelectorAll('.dynamic-soglia-item');
            
            items.forEach(el => {
                const nome = el.dataset.campionato;
                if (nome.includes(query)) {
                    el.classList.remove('hidden');
                } else {
                    el.classList.add('hidden');
                }
            });
        }

        // 6. CAMBIO TAB DI NAVIGAZIONE
        function navigaTab(tabNome) {
            document.getElementById('tab-home').classList.add('hidden');
            document.getElementById('tab-soglie').classList.add('hidden');
            
            document.getElementById('tab-' + tabNome).classList.remove('hidden');

            document.getElementById('nav-btn-home').className = "flex flex-col items-center justify-center w-14 h-12 text-zinc-500 hover:text-white transition";
            document.getElementById('nav-btn-soglie').className = "flex flex-col items-center justify-center w-14 h-12 text-zinc-500 hover:text-white transition";

            if (tabNome === 'home') {
                document.getElementById('nav-btn-home').className = "flex flex-col items-center justify-center w-14 h-12 text-cyan-400 transition";
            } else if (tabNome === 'soglie') {
                document.getElementById('nav-btn-soglie').className = "flex flex-col items-center justify-center w-14 h-12 text-cyan-400 transition";
                caricaSoglieLiveFisarmonica();
            }
            
            aggiungiLog("Navigazione su sezione: " + tabNome.toUpperCase(), "info");
        }

        // Calibrazione nitro massiva in background
        async function forzaCalibrazioneBackgroundCompleta() {
            if (!confirm("Desideri lanciare la calibrazione 'NITRO' per tutti i campionati attivi? L'operazione avverrà in background.")) return;
            try {
                aggiungiLog("Invio comando nitro massivo a Cloudflare...", "warning");
                const res = await fetch('/run-live');
                alert("Processo Nitro avviato correttamente in background su Cloudflare.");
                aggiungiLog("Nitro programmata correttamente sui Workers.", "success");
            } catch (err) {
                alert("Errore Nitro: " + err.message);
                aggiungiLog("Fallimento avvio Nitro: " + err.message, "error");
            }
        }

        // Reset completo della sessione
        function resetGeneraleEngine() {
            aggiungiLog("Reset generale della sessione in corso...", "warning");
            if (currentSseConnection) currentSseConnection.close();
            campionatiSelezionati = [];
            backtestResults = {};
            isProcessingInCorso = false;
            
            // Disattiva la Nitro se accesa
            if (isNitroModeAttiva) togglaNitroMode();
            
            aggiornaBottoneAvvioSoglie();
            
            // Ripristino grafico di tutte le card
            campionati.forEach(item => {
                const idCamp = pulisciId(item.campionato);
                const card = document.getElementById('card-' + idCamp);
                const indicator = document.getElementById('select-indicator-' + idCamp);
                
                if (card) card.className = "amoled-card rounded-xl p-4 transition duration-200 cursor-pointer select-none flex flex-col gap-2";
                if (indicator) indicator.classList.add('hidden');
                
                const progressoBox = document.getElementById('progresso-box-' + idCamp);
                const dettagliBox = document.getElementById('dettagli-box-' + idCamp);
                
                if (progressoBox) progressoBox.classList.add('hidden');
                if (dettagliBox) dettagliBox.classList.add('hidden');
            });

            navigaTab('home');
            aggiungiLog("Reset completato. Interfaccia ripristinata allo stato iniziale.", "success");
        }

        function formattaDataMMDDYYYY(dataStr) {
            if (!dataStr || dataStr === "-") return "-";
            var parti = dataStr.split("-");
            if (parti.length !== 3) return dataStr;
            return parti[1] + "-" + parti[2] + "-" + parti[0]; // Restituisce MM-DD-YYYY
        }

        function pulisciId(str) {
            return str.replace(/[^a-zA-Z0-9]/g, '-');
        }
    </script>
</body>
</html>
  `;
}