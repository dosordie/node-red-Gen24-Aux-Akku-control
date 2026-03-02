// Node-RED Function: BYD2 Hauptlogik
// Output 0: msg.payload = P_set_aux (W)  [SBC mit Deadband]
// Output 1: msg.payload = Debug-Objekt


// -------------------------
// Allgemein / Takt / Failsafe
// -------------------------

const TICK_INTERVAL_S  = 3;    // Wie oft die Funktion typischerweise getriggert wird (nur Info/Doc)
const FAILSAFE_ACTIVE  = true; // true = bei ungültigen Messwerten in FREEZE gehen

// Ab welcher Änderung die Funktion am Ausgang überhaupt sendet (SBC-Deadband)
const P_SET_DEADBAND_W = 20;   // Änderungen von P_set_aux < 20 W werden ignoriert


// -------------------------
// Leistungs-Grenzen / -Schwellen
// -------------------------

const AUX_BAT_MAX_W     = 7680; // Max. Lade-/Entladeleistung Akku 2 laut BYD-Setpoint (für %-Berechnung)
const AUX_WR_AC_MAX_W   = 3300; // Max. AC-Leistung des kleinen WR (physikalische Grenze am Netz)

const BASELOAD_TARGET_W = 2500;  // Ziel-Grundlast, die Akku 2 im DIS_BASE (GRID-Modus) maximal decken soll /war 768 jetzt 1536 (0,2C) / 2500

const GRID_IMPORT_MIN_W = 150;  // Ab diesem Netzbezug (W) wird GRID-Import als „relevant“ betrachtet
const GRID_EXPORT_MIN_W = 150;  // Ab dieser Einspeisung (W) wird GRID-Export als „relevant“ betrachtet
const GRID_TOLERANCE_W  = 80;   // Toleranz-Band um 0 W, um Flattern zu vermeiden / war 50


// -------------------------
// Delays / Trägheit
// -------------------------

const DIS_START_DELAY_S = 40;       // Dauer mit relevantem Netzbezug, bevor DIS_BASE (GRID) startet
const CHG_START_DELAY_S = 15;       // Dauer mit relevantem Export, bevor CHG_SURPLUS startet // war 20 sek 15.1.26
const MIN_STATE_HOLD_TIME_S = 15;   // Mindestzeit, die ein Zustand gehalten werden muss // war 15 sek 15.1.26

// Wie lange kleiner Import / 0 W am Netzpunkt anliegen muss,
// bevor CHG_SURPLUS beendet werden darf (zusätzlich zu anderen Bedingungen)
const CHG_STOP_IMPORT_DELAY_S = 25; // in Sekunden


// -------------------------
// SoC-Logik
// -------------------------

const SOC_MAIN_MIN_FOR_AUX_CHARGE   = 15; // Hauptakku-SoC muss mind. so hoch sein, damit Akku 2 aktiv geladen wird

const SOC_AUX_MIN_DISCHARGE_DEFAULT = 5;  // Fallback: Unter diesem SoC entlädt Akku 2 nicht mehr aktiv


// -------------------------
// Interaktion mit Hauptakku
// -------------------------

const MAIN_DISCHARGE_WEAK_W   = 70;   // Bis zu dieser Entladeleistung des Hauptakkus ist „leichtes“ Entladen des Hauptakkus ok // War 200
const MAIN_DISCHARGE_STRONG_W = 120;  // Ab dieser Entladeleistung wird CHG_SURPLUS (Laden Akku 2) beendet/blockiert

// Support-Mode für DIS_BASE (Hauptakku entlasten):
const MAIN_DIS_SUPPORT_ENTRY_W = 400; // Ab dieser Entladeleistung Hauptakku → SUPPORT-Modus erlaubt
const MAIN_DIS_SUPPORT_EXIT_W  = 100; // Fällt P_main_dis darunter → SUPPORT-Modus Ende

// Entlade-Verhältnis Haupt/Aux: z.B. 12.8 kWh / 7.7 kWh = 1.662
// Ziel: beide Akkus entladen grob proportional zu ihrer Kapazität
const MAIN_TO_AUX_CAP_RATIO    = 1.662; // P_aux ≈ P_main / 1.662

// Schrittweite für Unterstützungsleistung von Akku 2 im SUPPORT-Modus
const SUPPORT_STEP_W           = 70;    // in W, z.B. 70 W

// Hysterese für Ziel-Leistung im SUPPORT-Modus:
// Neuer Step wird nur übernommen, wenn er sich mind. so stark vom alten Ziel unterscheidet
const SUPPORT_TARGET_HYST_W    = 100;   // in W – neue Zielstufe nur bei >= 100 W Differenz


// -------------------------
// Anti "Akku2 lädt Akku1" (nur DIS_GRID)
// -------------------------
//
// Problem: Akku2 entlädt, schießt kurz ins Export -> Hauptakku beginnt zu laden (AC-Laden)
// Lösung: Wenn Export oder Hauptakku lädt, Entladung proportional reduzieren, bis
//         Pg wieder leicht positiv/kein Export und Hauptakku nicht mehr lädt.
//
// Hysterese, damit es nicht flattert:
const MAIN_CHARGE_STOP_DIS_W    = 120; // ab dieser Ladeleistung Hauptakku -> AntiCharge aktiv
const MAIN_CHARGE_RELEASE_DIS_W = 40;  // erst darunter wird AntiCharge wieder aus
//
// Separate "Down"-Rampe in DIS_GRID, damit wir bei Export/Hauptakku-lädt schnell Richtung 0 kommen:
const AUX_P_DELTA_MAX_DIS_DOWN_W = 600; // max. Änderung pro Tick beim "Runterregeln" (Richtung 0) in DIS_GRID


// -------------------------
// Ladeleistung begrenzen wenn Akku „voll“ wird
// -------------------------

const AUX_MAX_CELL_V        = 3.44; // Zellspannungs-Grenze (V), ab der Ladeleistung begrenzt wird
const AUX_MAX_CHARGE_FULL_W = 384;   // Max. Ladeleistung (W), wenn AUX_MAX_CELL_V überschritten ist

// Basis-Limit für Ladeleistung im CHG_SURPLUS (z.B. 0,2C= 77*20%)
//const MAX_CHG_POWER_W = 3300;  // in W, muss <= AUX_WR_AC_MAX_W sein, 1536=0,2C, 1690=0,22C, 1920=0,25C, 2310=0,3C 3080=0,4C
const MAX_CHG_POWER_W = Number(global.get("OstWest_MAX_CHG_POWER") || 1536); // Max Ladeleistung aus Global holen


// -------------------------
// Rampe (getrennt Laden / Entladen)
// -------------------------

// Laden: schneller hochfahren
const AUX_P_DELTA_MAX_CHG_W = 400; // max. Änderung pro Tick beim Laden (W) // war 200
const RAMP_MIN_HOLD_CHG_S   = 9;  // min. Zeit zwischen zwei „größer werden“ beim Laden (s) /war 10

// Entladen: wie bisher (träger)
const AUX_P_DELTA_MAX_DIS_W = 160;  // max. Änderung pro Tick beim Entladen (W) // war 80
const RAMP_MIN_HOLD_DIS_S   = 20;  // min. Zeit zwischen zwei „größer werden“ beim Entladen (s) // war 30


// -------------------------
// Freigaben / Key-Namen
// -------------------------

// Global-Variablen (Freigaben)
const GLOBAL_KEY_AUX_CHG_EN = "OstWest_Freigabe_Akku_Autom_Laden";    // bool, Auto-Laden Akku 2 erlaubt
const GLOBAL_KEY_AUX_DIS_EN = "OstWest_Freigabe_Akku_Autom_Entladen"; // bool, Auto-Entladen Akku 2 erlaubt

// Flow-Variablen (Konfiguration / Messwerte)
const FLOW_KEY_SOC_AUX_MIN        = "OstWest_Akku_min_SoC";           // min. SoC für Entladen Akku 2 (%, Fallback 5)
const FLOW_KEY_AUX_LIMIT_FULL_EN  = "OstWest_Akku_Limit_Charge_Full"; // bool, Lade-Limit bei fast voll aktiv
const FLOW_KEY_AUX_MAX_CELL_V     = "byd_1-olli_mVoltMax";            // max. Zellspannung in V (3 Nachkommastellen)


// -------------------------
// Zustände
// -------------------------

const STATE_IDLE        = "IDLE";        // Kein spezieller Lade-/Entlademodus aktiv
const STATE_CHG_SURPLUS = "CHG_SURPLUS"; // PV-Überschuss: Akku 2 lädt (träge, kumuliert)
const STATE_DIS_BASE    = "DIS_BASE";    // Grundlast decken / Support: Akku 2 entlädt
const STATE_FREEZE      = "FREEZE";      // Failsafe / Fehlerzustand – kein aktives Laden/Entladen

// DIS_BASE-Modus: Unterscheidung nach Auslöser
const DIS_MODE_GRID     = "GRID";        // DIS_BASE wegen Netzbezug
const DIS_MODE_SUPPORT  = "SUPPORT";     // DIS_BASE, um Hauptakku bei Entladung zu unterstützen


// -------------------------
// Hilfsfunktionen
// -------------------------

function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}

function isFiniteNumber(v) {
    return typeof v === "number" && isFinite(v);
}


// ------------------------------------------------------
// 1) Werte aus global/flow holen
// ------------------------------------------------------

const P_grid_raw = global.get("200.40097_W");  // Leistung am Netzverknüpfungspunkt (+Bezug, -Einspeisung)

const SoC_main   = Number(global.get("BYD_SoC"));    // SoC Hauptakku in %
const SoC_aux    = Number(global.get("BYD7.7_SoC")); // SoC Akku 2 in %

const P_main_chg = Number(global.get("GEN24-8.0_Akku_Laden_W")    || 0); // Hauptakku-Ladeleistung
const P_main_dis = Number(global.get("GEN24-8.0_Akku_Entladen_W") || 0); // Hauptakku-Entladeleistung

const P_aux_chg  = Number(global.get("GEN24-3.0_Akku_Laden_W")    || 0); // Akku 2 - Ladeleistung
const P_aux_dis  = Number(global.get("GEN24-3.0_Akku_Entladen_W") || 0); // Akku 2 - Entladeleistung

let P_house      = global.get("Hausverbrauch_W"); // Hausverbrauch (falls vorhanden)

const auxChargeEnable    = !!global.get(GLOBAL_KEY_AUX_CHG_EN);
const auxDischargeEnable = !!global.get(GLOBAL_KEY_AUX_DIS_EN);

let P_grid = Number(P_grid_raw);
if (!isFiniteNumber(P_grid))  P_grid  = 0;
if (!isFiniteNumber(P_house)) P_house = NaN;

// Min-SoC Akku 2 aus Flow (Fallback 5 %)
let socAuxMinCfg          = Number(flow.get(FLOW_KEY_SOC_AUX_MIN));
let SOC_AUX_MIN_DISCHARGE = isFiniteNumber(socAuxMinCfg) ? socAuxMinCfg : SOC_AUX_MIN_DISCHARGE_DEFAULT;

// Voll-Limit-Logik aus Flow
const auxLimitFullEnable = !!flow.get(FLOW_KEY_AUX_LIMIT_FULL_EN);

// Wert kommt in V (z.B. 3.428)
let auxCellMaxV = Number(flow.get(FLOW_KEY_AUX_MAX_CELL_V));
if (!isFiniteNumber(auxCellMaxV) || auxCellMaxV <= 0) {
    auxCellMaxV = NaN;
}

// Effektiver Max-Charge-Limit (dynamisch)
let effectiveMaxChargeW = MAX_CHG_POWER_W;
let chargeLimitActive   = false;

if (auxLimitFullEnable && isFiniteNumber(auxCellMaxV) && auxCellMaxV >= AUX_MAX_CELL_V) {
    effectiveMaxChargeW = Math.min(MAX_CHG_POWER_W, AUX_MAX_CHARGE_FULL_W);
    chargeLimitActive   = true;
}


// ------------------------------------------------------
// 2) Failsafe
// ------------------------------------------------------

let failsafeReason = null;

if (FAILSAFE_ACTIVE) {
    if (!isFiniteNumber(P_grid_raw))     failsafeReason = "P_grid invalid";
    else if (!isFiniteNumber(SoC_main))  failsafeReason = "SoC_main invalid";
    else if (!isFiniteNumber(SoC_aux))   failsafeReason = "SoC_aux invalid";
}


// ------------------------------------------------------
// 3) State & Zeitkontexte laden
// ------------------------------------------------------

const now = Date.now();

let state             = context.get("state")             || STATE_IDLE;
let lastStateTs       = context.get("lastStateTs")       || now;
let lastPset          = context.get("P_set_aux")         || 0;
let disMode           = context.get("disMode")           || DIS_MODE_GRID;
let importHighSince   = context.get("importHighSince")   || 0;
let exportHighSince   = context.get("exportHighSince")   || 0;
let wasImportHigh     = context.get("wasImportHigh")     || false;
let wasExportHigh     = context.get("wasExportHigh")     || false;
let importStopSince   = context.get("importStopSince")   || 0;
let wasImportStop     = context.get("wasImportStop")     || false;
let lastRampTs        = context.get("lastRampTs")        || now;
let lastSupportTarget = context.get("lastSupportTarget") || 0;

// AntiCharge Latch (damit nicht flackert)
let antiChargeLatch   = !!context.get("antiChargeLatch");

const isGridImport = (P_grid >  (GRID_IMPORT_MIN_W + GRID_TOLERANCE_W));
const isGridExport = (P_grid < -(GRID_EXPORT_MIN_W + GRID_TOLERANCE_W));

// Import-Delay-Tracking (für DIS_START_DELAY_S)
if (isGridImport) {
    if (!wasImportHigh) {
        importHighSince = now;
        wasImportHigh   = true;
    }
} else {
    importHighSince = 0;
    wasImportHigh   = false;
}
const tGridImportHigh = importHighSince ? (now - importHighSince) / 1000 : 0;

// Export-Delay-Tracking (für CHG_START_DELAY_S)
if (isGridExport) {
    if (!wasExportHigh) {
        exportHighSince = now;
        wasExportHigh   = true;
    }
} else {
    exportHighSince = 0;
    wasExportHigh   = false;
}
const tGridExportHigh = exportHighSince ? (now - exportHighSince) / 1000 : 0;

// „kleiner Import“ / 0 W → wann stoppen wir CHG_SURPLUS?
const isSmallImport = (P_grid >= 0);

if (isSmallImport) {
    if (!wasImportStop) {
        importStopSince = now;
        wasImportStop   = true;
    }
} else {
    importStopSince = 0;
    wasImportStop   = false;
}
const tImportStop = importStopSince ? (now - importStopSince) / 1000 : 0;

// State-Haltezeit
const tStateHold = (now - lastStateTs) / 1000;


// ------------------------------------------------------
// 3.1) AntiCharge-Detect (Hysterese + Latch)
// ------------------------------------------------------
//
// Aktiv wenn Hauptakku sichtbar lädt (P_main_chg), und erst deaktiv wenn deutlich drunter.
if (!antiChargeLatch) {
    if (P_main_chg >= MAIN_CHARGE_STOP_DIS_W) antiChargeLatch = true;
} else {
    if (P_main_chg <= MAIN_CHARGE_RELEASE_DIS_W) antiChargeLatch = false;
}
context.set("antiChargeLatch", antiChargeLatch);


// ------------------------------------------------------
// 4) Failsafe-Übergang in FREEZE
// ------------------------------------------------------

if (failsafeReason && state !== STATE_FREEZE) {
    state       = STATE_FREEZE;
    lastStateTs = now;
}


// ------------------------------------------------------
// 5) State-Machine
// ------------------------------------------------------

let nextState = state;

if (state === STATE_FREEZE) {

    if (!failsafeReason && tStateHold >= MIN_STATE_HOLD_TIME_S) {
        nextState   = STATE_IDLE;
        lastStateTs = now;
    }

} else {

    const allowTransition = (tStateHold >= MIN_STATE_HOLD_TIME_S);

    if (failsafeReason) {
        nextState   = STATE_FREEZE;
        lastStateTs = now;

    } else if (allowTransition) {

        switch (state) {

            case STATE_IDLE: {
                const wasChargingBefore = (lastPset > 0); // Laden = positiver Wert

                // Laden aus Überschuss (CHG_SURPLUS)
                if (auxChargeEnable &&
                    SoC_main >= SOC_MAIN_MIN_FOR_AUX_CHARGE &&
                    P_main_dis <= MAIN_DISCHARGE_WEAK_W &&
                    isGridExport &&
                    P_main_dis <= MAIN_DISCHARGE_STRONG_W) {

                    if (wasChargingBefore || tGridExportHigh >= CHG_START_DELAY_S) {
                        nextState   = STATE_CHG_SURPLUS;
                        lastStateTs = now;
                    }
                }
                // Grundlast entladen bei Netzbezug (DIS_BASE, GRID-Modus)
                else if (auxDischargeEnable &&
                         SoC_aux > SOC_AUX_MIN_DISCHARGE &&
                         isGridImport &&
                         tGridImportHigh >= DIS_START_DELAY_S) {

                    nextState   = STATE_DIS_BASE;
                    disMode     = DIS_MODE_GRID;
                    context.set("disMode", disMode);
                    lastStateTs = now;
                }
                // Hauptakku-Support (DIS_BASE, SUPPORT-Modus)
                else if (auxDischargeEnable &&
                         SoC_aux > SOC_AUX_MIN_DISCHARGE &&
                         P_main_dis >= MAIN_DIS_SUPPORT_ENTRY_W) {

                    nextState   = STATE_DIS_BASE;
                    disMode     = DIS_MODE_SUPPORT;
                    context.set("disMode", disMode);
                    lastStateTs = now;
                }
                break;
            }

            case STATE_CHG_SURPLUS: {
                // Nur aus CHG_SURPLUS raus, wenn wir wirklich „fertig“ sind:
                // länger Import/kein Überschuss UND bereits auf 0W runtergeregelt
                const importStopCond =
                    (P_grid >= 0 &&
                     tImportStop >= CHG_STOP_IMPORT_DELAY_S &&
                     lastPset === 0);

                if (!auxChargeEnable ||
                    SoC_main < SOC_MAIN_MIN_FOR_AUX_CHARGE ||
                    importStopCond ||
                    P_main_dis > MAIN_DISCHARGE_STRONG_W) {

                    nextState   = STATE_IDLE;
                    lastStateTs = now;
                }
                break;
            }

            case STATE_DIS_BASE: {
                let exit = false;

                if (!auxDischargeEnable || SoC_aux <= SOC_AUX_MIN_DISCHARGE) {
                    exit = true;
                } else if (disMode === DIS_MODE_GRID) {
                    // NEU: Nur raus, wenn kein Import mehr UND bereits keine Entladung mehr aktiv
                    if (P_grid <= 0 && lastPset === 0) exit = true;
                } else if (disMode === DIS_MODE_SUPPORT) {
                    if (P_main_dis < MAIN_DIS_SUPPORT_EXIT_W) exit = true;
                }

                if (exit) {
                    nextState         = STATE_IDLE;
                    disMode           = DIS_MODE_GRID;
                    lastSupportTarget = 0;
                    context.set("disMode", disMode);
                    context.set("lastSupportTarget", lastSupportTarget);
                    lastStateTs = now;
                }
                break;
            }
        }
    }
}


// ------------------------------------------------------
// 6) P_set_aux je nach nextState (Watt)
// ------------------------------------------------------
//
// P_set_aux > 0  → Akku 2 LADEN
// P_set_aux < 0  → Akku 2 ENTlädt
// ------------------------------------------------------

let P_set_aux_new = 0;

// Debug-Hilfswerte für AntiCharge (nur Info)
let antiChargeActiveW = 0;   // wieviel W wir Richtung 0 "wegnehmen"
let noExportActiveW   = 0;   // Anteil aus Export

if (nextState === STATE_CHG_SURPLUS && !failsafeReason) {

    // Laden dynamisch an P_grid anpassen:
    // - Export  → positiv (mehr laden)
    // - Import  → negativ (Ladeleistung reduzieren)
    // - nahe 0  → keine Änderung
    let P_surplus = 0;

    if (P_grid < -GRID_TOLERANCE_W) {
        // Export: wir können mehr laden
        P_surplus = -P_grid;            // z.B. Pg=-500 → +500W „mehr laden“
    } else if (P_grid > GRID_TOLERANCE_W) {
        // Import: zu viel geladen → wieder etwas runter
        P_surplus = -P_grid;            // z.B. Pg=+200 → -200W „weniger laden“
    } else {
        // in der Nähe von 0W → nichts tun
        P_surplus = 0;
    }

    // Ziel = bisherige Ladeleistung + Korrektur
    let P_target = P_aux_chg + P_surplus;

    // Niemals ins Entladen kippen
    if (P_target < 0) P_target = 0;

    // Begrenzen auf WR-Grenze, Basislimit und ggf. „Akku fast voll“-Limit:
    P_target      = Math.min(P_target, AUX_WR_AC_MAX_W, effectiveMaxChargeW);
    P_set_aux_new = P_target;  // positiv = Laden

} else if (nextState === STATE_DIS_BASE && !failsafeReason) {

    if (disMode === DIS_MODE_GRID) {

        // NEU: Entladung dynamisch über P_grid regeln
        // lastPset ist bisherige Entladeleistung (negativ), wir korrigieren darum herum:
        let P_old    = (lastPset < 0 ? lastPset : 0); // sicherstellen, dass wir von <=0 starten
        let P_target = P_old;

        let P_corr = 0;
        if (P_grid > GRID_TOLERANCE_W) {
            // Import: wir entladen zu wenig → stärker entladen
            P_corr = P_grid;           // z.B. Pg=+300 → mehr negative Leistung
        } else if (P_grid < -GRID_TOLERANCE_W) {
            // Export: wir entladen zu viel → Entladung reduzieren
            P_corr = P_grid;           // z.B. Pg=-200 → Entladung etwas kleiner
        } else {
            P_corr = 0;                // nahe 0 → halten
        }

        P_target = P_old - P_corr;     // negative Werte = Entladen

        // -------------------------
        // NEU: Anti "Akku2 lädt Akku1" (Option B proportional)
        // -------------------------
        //
        // Wenn Export oder Hauptakku lädt -> Entladung proportional reduzieren (Richtung 0),
        // bis Pg nicht mehr negativ ist und Hauptakku nicht mehr lädt.
        //
        // Export-Anteil:
        if (P_grid < -GRID_TOLERANCE_W) {
            noExportActiveW = (-P_grid);          // z.B. Pg=-200 => 200W weniger entladen
            antiChargeActiveW += noExportActiveW;
        }

        // Hauptakku-Laden-Anteil (Latch/Hysterese oben):
        if (antiChargeLatch) {
            antiChargeActiveW += Math.max(0, P_main_chg); // z.B. 300W laden => 300W weniger entladen
        }

        // Apply: P_target ist negativ -> + antiChargeActiveW reduziert Betrag Richtung 0
        if (antiChargeActiveW > 0) {
            P_target = P_target + antiChargeActiveW;
        }

        const maxDis = Math.min(BASELOAD_TARGET_W, AUX_WR_AC_MAX_W);

        if (P_target < -maxDis) P_target = -maxDis;
        if (P_target > 0)       P_target = 0;

        P_set_aux_new = Math.round(P_target);

    } else if (disMode === DIS_MODE_SUPPORT) {

        const P_main_dis_pos = Math.max(0, P_main_dis);

        let P_aux_target_raw = 0;
        if (MAIN_TO_AUX_CAP_RATIO > 0) {
            P_aux_target_raw = P_main_dis_pos / MAIN_TO_AUX_CAP_RATIO;
        }

        let P_aux_target = Math.min(P_aux_target_raw, AUX_WR_AC_MAX_W);

        if (SUPPORT_STEP_W > 0) {
            P_aux_target = Math.round(P_aux_target / SUPPORT_STEP_W) * SUPPORT_STEP_W;
        }

        if (lastSupportTarget > 0 && P_aux_target > 0) {
            if (Math.abs(P_aux_target - lastSupportTarget) < SUPPORT_TARGET_HYST_W) {
                P_aux_target = lastSupportTarget;
            }
        }

        if (P_aux_target < SUPPORT_STEP_W) {
            P_set_aux_new     = 0;
            lastSupportTarget = 0;
        } else {
            P_set_aux_new     = -P_aux_target;
            lastSupportTarget = P_aux_target;
        }

        context.set("lastSupportTarget", lastSupportTarget);
    }

} else {
    P_set_aux_new     = 0;
    lastSupportTarget = 0;
    context.set("lastSupportTarget", lastSupportTarget);
}


// ------------------------------------------------------
// 7) Rampe (getrennt für Laden / Entladen)
// ------------------------------------------------------

let P_set_aux;

const dtRamp        = (now - lastRampTs) / 1000;
const isSupportMode = (nextState === STATE_DIS_BASE && disMode === DIS_MODE_SUPPORT);

const magOld        = Math.abs(lastPset);
const magNew        = Math.abs(P_set_aux_new);

const magnitudeIncreases = (magNew > magOld);

let holdMagnitude   = false;

// Welcher Rampen-Satz?
const isCharging    = (P_set_aux_new > 0);
const isDischarging = (P_set_aux_new < 0);

// min. Haltezeit und max. Delta je nach Richtung
let rampHoldMinS    = isCharging ? RAMP_MIN_HOLD_CHG_S   : RAMP_MIN_HOLD_DIS_S;
let rampDeltaMaxW   = isCharging ? AUX_P_DELTA_MAX_CHG_W : AUX_P_DELTA_MAX_DIS_W;

// NEU: DIS_GRID "Down"-Rampe schneller, wenn Export oder Hauptakku lädt
const isDisGridMode = (nextState === STATE_DIS_BASE && disMode === DIS_MODE_GRID && isDischarging);
const guardDownActive = isDisGridMode && (antiChargeActiveW > 0); // Export/Hauptakku-lädt Anteil aktiv?

// Wenn wir im DIS_GRID gerade runterregeln (Betrag kleiner) und Guard aktiv ist,
// dann schneller Richtung 0 (ohne zusätzliche Hold-Blockade).
if (guardDownActive && (magNew < magOld)) {
    rampDeltaMaxW = Math.max(rampDeltaMaxW, AUX_P_DELTA_MAX_DIS_DOWN_W);
    // runterregeln soll sofort dürfen -> keine holdMagnitude wegen Zeitfenster
}

// Bestehende Hold-Logik (für "größer werden")
if (isDischarging && isSupportMode) {
    // Support-Modus: wie bisher „träger“
    const magnitudeChanged = (magNew !== magOld);
    if (P_set_aux_new !== 0 && magnitudeChanged && dtRamp < rampHoldMinS) {
        holdMagnitude = true;
    }
} else {
    // Standard: bei größerer Stellgröße nur alle rampHoldMinS hochfahren
    if (magnitudeIncreases && dtRamp < rampHoldMinS) {
        holdMagnitude = true;
    }

    // NEU: wenn guardDownActive und wir kleiner werden, NICHT halten
    if (guardDownActive && (magNew < magOld)) {
        holdMagnitude = false;
    }
}

if (holdMagnitude) {
    P_set_aux = lastPset;
} else {
    const delta = P_set_aux_new - lastPset;

    if (Math.abs(delta) > rampDeltaMaxW) {
        P_set_aux = lastPset + Math.sign(delta) * rampDeltaMaxW;
    } else {
        P_set_aux = P_set_aux_new;
    }

    if (P_set_aux !== lastPset) {
        lastRampTs = now;
    }
}

P_set_aux = clamp(P_set_aux, -AUX_WR_AC_MAX_W, AUX_WR_AC_MAX_W);
if (Math.abs(P_set_aux) < 10) P_set_aux = 0;
P_set_aux = Math.round(P_set_aux);


// ------------------------------------------------------
// 8) Node-Status + Debug
// ------------------------------------------------------

let dbgState = nextState;
if (nextState === STATE_DIS_BASE) {
    dbgState = (disMode === DIS_MODE_SUPPORT) ? "DIS_SUPPORT" : "DIS_GRID";
}

let freeStr = "F:";
if (auxChargeEnable && auxDischargeEnable) freeStr += "LD";
else if (auxChargeEnable)                 freeStr += "L";
else if (auxDischargeEnable)              freeStr += "D";
else                                      freeStr += "-";

// Status-Flags für DIS_GRID
let disFlags = "";
if (dbgState === "DIS_GRID") {
    const flags = [];
    if (P_grid < -GRID_TOLERANCE_W) flags.push("EXP");
    if (antiChargeLatch)            flags.push("A1CHG");
    if (flags.length) disFlags = " [" + flags.join(",") + "]";
}

const dbg = {
    state:              dbgState,
    stateBase:          nextState,
    disMode,
    failsafeReason:     failsafeReason || null,
    P_grid,
    P_house,
    SoC_main,
    SoC_aux,
    socAuxMinDischarge: SOC_AUX_MIN_DISCHARGE,
    P_main_chg,
    P_main_dis,
    P_aux_chg,
    P_aux_dis,
    auxChargeEnable,
    auxDischargeEnable,
    tGridImportHigh,
    tGridExportHigh,
    tImportStop,
    tStateHold,
    P_set_aux,
    lastSupportTarget,
    chargeLimitActive,
    auxLimitFullEnable,
    auxCellMaxV,
    effectiveMaxChargeW,

    // NEU Debug:
    antiChargeLatch,
    antiChargeActiveW,   // Summe der "wegnehm"-W (Export + Hauptakku-Laden)
    noExportActiveW      // nur Exportanteil
};

let statusColor = "grey";
let statusText  = "";

switch (nextState) {
    case STATE_IDLE:
        statusColor = "grey";
        statusText  = `IDLE ${freeStr} P=${P_set_aux.toFixed(0)}W Pg=${P_grid.toFixed(0)}W`;
        break;

    case STATE_CHG_SURPLUS:
        statusColor = "green";
        statusText  = `CHG${chargeLimitActive ? " (LIM)" : ""} ${freeStr} ` +
                      `P=${P_set_aux.toFixed(0)}W Pg=${P_grid.toFixed(0)}W SoC_main=${SoC_main}%`;
        break;

    case STATE_DIS_BASE:
        if (disMode === DIS_MODE_GRID) {
            statusColor = "yellow";
            statusText  = `DIS_GRID${disFlags} ${freeStr} P=${P_set_aux.toFixed(0)}W Pg=${P_grid.toFixed(0)}W SoC_aux=${SoC_aux}%`;
        } else {
            statusColor = "orange";
            statusText  = `DIS_SUPPORT ${freeStr} P=${P_set_aux.toFixed(0)}W Pg=${P_grid.toFixed(0)}W SoC_aux=${SoC_aux}%`;
        }
        break;

    case STATE_FREEZE:
        statusColor = "red";
        statusText  = `FREEZE ${freeStr} ${failsafeReason || ""}`;
        break;
}

node.status({ fill: statusColor, shape: "dot", text: statusText });


// ------------------------------------------------------
// 9) Kontext aktualisieren
// ------------------------------------------------------

context.set("state",             nextState);
context.set("lastStateTs",       lastStateTs);
context.set("P_set_aux",         P_set_aux);
context.set("importHighSince",   importHighSince);
context.set("exportHighSince",   exportHighSince);
context.set("wasImportHigh",     wasImportHigh);
context.set("wasExportHigh",     wasExportHigh);
context.set("disMode",           disMode);
context.set("importStopSince",   importStopSince);
context.set("wasImportStop",     wasImportStop);
context.set("lastRampTs",        lastRampTs);
context.set("lastSupportTarget", lastSupportTarget);


// ------------------------------------------------------
// 10) SBC-Logik für P_set_aux (mit Deadband)
// ------------------------------------------------------

const lastOutP = context.get("lastOutP");
let msgP   = null;
let msgDbg = null;

// Zusatzbedingungen:
const firstRun     = (lastOutP === undefined);
const diff         = firstRun ? Infinity : Math.abs(P_set_aux - lastOutP);
const crossedZero  = !firstRun && (P_set_aux === 0 && lastOutP !== 0);
const signChanged  = !firstRun && (Math.sign(P_set_aux) !== Math.sign(lastOutP));

if (
    firstRun ||
    diff >= P_SET_DEADBAND_W ||
    crossedZero ||          // immer senden, wenn wir auf 0 gehen
    signChanged             // immer senden bei Wechsel Laden ↔ Entladen
) {
    msgP = { payload: P_set_aux };
    context.set("lastOutP", P_set_aux);
}

// Debug SBC
const lastDbgJson = context.get("lastDbgJson");
const dbgJson     = JSON.stringify(dbg);

if (dbgJson !== lastDbgJson) {
    msgDbg = { payload: dbg };
    context.set("lastDbgJson", dbgJson);
}

return [msgP, msgDbg];
