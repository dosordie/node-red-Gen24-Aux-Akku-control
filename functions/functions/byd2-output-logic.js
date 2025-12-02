// Node-RED Function: BYD2 Ausgangslogik (optimiert mit richtiger Reihenfolge)
// Input:  msg.payload = P_set_aux (W), >0 = Laden, <0 = Entladen
// Output 0: InWRte  (%), SBC
// Output 1: OutWRte (%), SBC
//
// BYD-Logik:
//  - Laden erzwingen:    OutWRte < 0, InWRte > 0, In ≥ |Out|
//  - Entladen erzwingen: InWRte  < 0, OutWRte > 0, Out ≥ |In|
//
// Wir setzen:
//  - Laden:    In = +X, Out = -X
//  - Entladen: Out = +X, In = -X
//
// Reihenfolge bei Änderung (gleicher Modus):
//  - CHG hoch:    zuerst In+, dann Out−
//  - CHG runter:  zuerst Out−, dann In+
//  - DIS hoch:    zuerst Out+, dann In−
//  - DIS runter:  zuerst In−, dann Out+
//
// Bei Soll = 0: erst das bisher negative Register auf 0, dann das positive mit Delay.


// -------------------------
// Konfiguration
// -------------------------

const AUX_BAT_MAX_W = 7680;   // Setpoint max charge (für %-Berechnung)
const NEG_DELAY_MS  = 500;    // Verzögerung für "zweite" Nachricht (ms)


// Hilfsfunktionen
function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}

function isFiniteNumber(v) {
    return typeof v === "number" && isFinite(v);
}

function round1(x) {
    return Number(x.toFixed(1));   // 1 Nachkommastelle
}


// ------------------------------------------------------
// 1) P_set_aux aus msg.payload lesen
// ------------------------------------------------------

let P_set_aux = Number(msg.payload);
if (!isFiniteNumber(P_set_aux)) {
    P_set_aux = 0;
}

// kleine Werte auf 0 (Hysterese gegen Flattern)
if (Math.abs(P_set_aux) < 10) {
    P_set_aux = 0;
}


// ------------------------------------------------------
// 2) Kontext: letzte Werte
// ------------------------------------------------------

const prevInWRte  = Number(context.get("lastInWRte")  || 0);
const prevOutWRte = Number(context.get("lastOutWRte") || 0);

// alten Modus + alte Magnitude ermitteln (für Reihenfolge-Logik)
let prevMode = "NEUTRAL";  // NEUTRAL | CHG | DIS
let prevMag  = 0;

if (prevInWRte < 0 && prevOutWRte >= 0) {
    // Entladen erzwingen aktiv
    prevMode = "DIS";
    prevMag  = Math.max(Math.abs(prevInWRte), Math.abs(prevOutWRte));
} else if (prevOutWRte < 0 && prevInWRte >= 0) {
    // Laden erzwingen aktiv
    prevMode = "CHG";
    prevMag  = Math.max(Math.abs(prevOutWRte), Math.abs(prevInWRte));
}


// ------------------------------------------------------
// 3) Sonderfall: Soll = 0 → geordnete 0-Sequenz
// ------------------------------------------------------
//
// Ziel: WR sauber aus "erzwingen"-Modus holen.
// - Wenn ein Register negativ war, zuerst dieses Register auf 0 (ohne Delay),
//   dann das jeweils andere (positive) mit Delay.
// - Wenn nichts negativ, einfach beide ggf. auf 0 setzen.
//

if (P_set_aux === 0) {
    let msgIn  = null;
    let msgOut = null;

    if (prevInWRte !== 0 || prevOutWRte !== 0) {

        // Fall A: In war negativ (DIS aktiv)
        if (prevInWRte < 0) {
            if (prevInWRte !== 0) {
                msgIn = { payload: 0 };
                context.set("lastInWRte", 0);
            }
            if (prevOutWRte !== 0) {
                msgOut = { payload: 0, delay: NEG_DELAY_MS };
                context.set("lastOutWRte", 0);
            }
        }
        // Fall B: Out war negativ (CHG aktiv)
        else if (prevOutWRte < 0) {
            if (prevOutWRte !== 0) {
                msgOut = { payload: 0 };
                context.set("lastOutWRte", 0);
            }
            if (prevInWRte !== 0) {
                msgIn = { payload: 0, delay: NEG_DELAY_MS };
                context.set("lastInWRte", 0);
            }
        }
        // Fall C: keins war negativ (Startzustand / nur positive Werte)
        else {
            if (prevInWRte !== 0) {
                msgIn = { payload: 0 };
                context.set("lastInWRte", 0);
            }
            if (prevOutWRte !== 0) {
                msgOut = { payload: 0 };
                context.set("lastOutWRte", 0);
            }
        }
    }

    node.status({
        fill:  "blue",
        shape: "dot",
        text:  `P=0W  In=0.0%  Out=0.0%`
    });

    return [msgIn, msgOut];
}


// ------------------------------------------------------
// 4) Modus + Betrag (in %) aus P_set_aux ableiten (für ≠ 0)
// ------------------------------------------------------
//
// P_set_aux > 0  → CHG (Laden erzwingen)
// P_set_aux < 0  → DIS (Entladen erzwingen)
// ------------------------------------------------------

let desiredMode = "NEUTRAL"; // NEUTRAL | CHG | DIS
let desiredMag  = 0;         // Betrag in %

{
    let pct = (P_set_aux / AUX_BAT_MAX_W) * 100;
    pct = clamp(pct, -100, 100);
    pct = round1(pct);  // 0,1 %

    const mag = Math.min(100, Math.abs(pct));

    if (mag > 0.05) {
        desiredMag = round1(mag);
        if (pct > 0) {
            desiredMode = "CHG";   // >0 = Laden
        } else {
            desiredMode = "DIS";   // <0 = Entladen
        }
    } else {
        desiredMode = "NEUTRAL";
    }
}

// Sicherheits-Fallback: wenn aus irgendeinem Grund NEUTRAL → wie Soll=0 behandeln
if (desiredMode === "NEUTRAL" || desiredMag === 0) {
    // auf Nummer sicher: alles auf 0
    let msgIn  = null;
    let msgOut = null;

    if (prevInWRte !== 0) {
        msgIn = { payload: 0 };
        context.set("lastInWRte", 0);
    }
    if (prevOutWRte !== 0) {
        msgOut = { payload: 0 };
        context.set("lastOutWRte", 0);
    }

    node.status({
        fill:  "blue",
        shape: "dot",
        text:  `P≈0W  In=0.0%  Out=0.0%`
    });

    return [msgIn, msgOut];
}


// ------------------------------------------------------
// 5) InWRte / OutWRte berechnen (symmetrisch)
// ------------------------------------------------------
//
// Laden:    In = +X, Out = -X
// Entladen: Out = +X, In = -X
// ------------------------------------------------------

let InWRte  = 0;
let OutWRte = 0;

if (desiredMode === "CHG") {
    InWRte  = desiredMag;
    OutWRte = -desiredMag;
} else if (desiredMode === "DIS") {
    OutWRte = desiredMag;
    InWRte  = -desiredMag;
}

// End-Rundung
InWRte  = round1(InWRte);
OutWRte = round1(OutWRte);

// neue Magnitude (max. Betrag von In/Out)
const newMag = Math.max(Math.abs(InWRte), Math.abs(OutWRte));

// Änderungstendenz ermitteln (mit kleiner Toleranz)
const MAG_EPS = 0.05;
const magDecreasing = (newMag + MAG_EPS < prevMag);
const magIncreasing = (newMag > prevMag + MAG_EPS);


// ------------------------------------------------------
// 6) SBC-Logik + Reihenfolge/Delay für CHG/DIS
// ------------------------------------------------------
//
// Idee:
//  - Wir senden max. eine Nachricht pro Register.
//  - Reihenfolge wird über msg.delay (NEG_DELAY_MS) gesteuert.
//  - Bei Leistungsänderungen im gleichen Modus:
//
//    CHG (Laden): In > 0, Out < 0
//       - hoch:   zuerst In+, dann Out−
//       - runter: zuerst Out−, dann In+
//
//    DIS (Entladen): In < 0, Out > 0
//       - hoch:   zuerst Out+, dann In−
//       - runter: zuerst In−, dann Out+
//
//  - Wenn Modus gewechselt hat (CHG <-> DIS), machen wir hier
//    nichts Besonderes – deine Hauptlogik ramped ja über 0
//    und wir haben oben eine Hysterese.
// ------------------------------------------------------

let msgIn  = null;
let msgOut = null;

// Falls sich nichts ändert → nichts senden
if (InWRte === prevInWRte && OutWRte === prevOutWRte) {

    node.status({
        fill:  "blue",
        shape: "dot",
        text:  `P=${P_set_aux.toFixed(0)}W  In=${InWRte.toFixed(1)}%  Out=${OutWRte.toFixed(1)}%`
    });

    return [null, null];
}

// Hilfsfunktion: einfache „sofort senden“-Variante (z.B. bei Moduswechsel)
function sendSimple() {
    let mIn  = null;
    let mOut = null;

    if (InWRte !== prevInWRte) {
        mIn = { payload: InWRte };
        if (InWRte < 0) {
            mIn.delay = NEG_DELAY_MS;
        }
        context.set("lastInWRte", InWRte);
    }

    if (OutWRte !== prevOutWRte) {
        mOut = { payload: OutWRte };
        if (OutWRte < 0) {
            mOut.delay = NEG_DELAY_MS;
        }
        context.set("lastOutWRte", OutWRte);
    }

    return [mIn, mOut];
}

// Wenn der Modus wechselt (CHG <-> DIS), nehmen wir die einfache Variante.
// (Optional könnte man hier noch einen Zwischen-0-Schritt erzwingen.)
if (prevMode !== "NEUTRAL" && prevMode !== desiredMode) {
    [msgIn, msgOut] = sendSimple();
} else {

    // Modus bleibt gleich → wir können fein differenzieren.
    if (desiredMode === "CHG") {
        // In > 0, Out < 0
        if (magIncreasing) {
            // CHG hoch: zuerst In+, dann Out−
            if (InWRte !== prevInWRte) {
                msgIn = { payload: InWRte };           // sofort
                context.set("lastInWRte", InWRte);
            }
            if (OutWRte !== prevOutWRte) {
                msgOut = { payload: OutWRte, delay: NEG_DELAY_MS }; // verzögert (negativ)
                context.set("lastOutWRte", OutWRte);
            }
        } else if (magDecreasing) {
            // CHG runter: zuerst Out−, dann In+
            if (OutWRte !== prevOutWRte) {
                msgOut = { payload: OutWRte };         // zuerst
                context.set("lastOutWRte", OutWRte);
            }
            if (InWRte !== prevInWRte) {
                msgIn = { payload: InWRte, delay: NEG_DELAY_MS };   // dann
                context.set("lastInWRte", InWRte);
            }
        } else {
            // Magnitude quasi gleich → einfache Variante
            [msgIn, msgOut] = sendSimple();
        }
    } else if (desiredMode === "DIS") {
        // Out > 0, In < 0
        if (magIncreasing) {
            // DIS hoch: zuerst Out+, dann In−
            if (OutWRte !== prevOutWRte) {
                msgOut = { payload: OutWRte };         // zuerst
                context.set("lastOutWRte", OutWRte);
            }
            if (InWRte !== prevInWRte) {
                msgIn = { payload: InWRte, delay: NEG_DELAY_MS };   // dann (negativ)
                context.set("lastInWRte", InWRte);
            }
        } else if (magDecreasing) {
            // DIS runter: zuerst In−, dann Out+
            if (InWRte !== prevInWRte) {
                msgIn = { payload: InWRte };           // zuerst (negativ, aber ohne Delay)
                context.set("lastInWRte", InWRte);
            }
            if (OutWRte !== prevOutWRte) {
                msgOut = { payload: OutWRte, delay: NEG_DELAY_MS }; // dann positiv verzögert
                context.set("lastOutWRte", OutWRte);
            }
        } else {
            // Magnitude quasi gleich → einfache Variante
            [msgIn, msgOut] = sendSimple();
        }
    } else {
        // sollte eigentlich nicht vorkommen, fallback
        [msgIn, msgOut] = sendSimple();
    }
}


// ------------------------------------------------------
// 7) Node-Status
// ------------------------------------------------------

node.status({
    fill:  "blue",
    shape: "dot",
    text:  `P=${P_set_aux.toFixed(0)}W  In=${InWRte.toFixed(1)}%  Out=${OutWRte.toFixed(1)}%`
});

return [msgIn, msgOut];
