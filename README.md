# Node-RED – BYD Aux-Akku 2 Regelung

Dieses Repository enthält die Node-RED-Logik zur Steuerung eines zweiten BYD-Akkus (Aux-Akku) an einem separaten GEN24.

Die Regelung besteht aus zwei Funktionsknoten:

1. **BYD2 Hauptlogik**  
   Arbeitet auf Watt-Basis (`P_set_aux`) und entscheidet, ob und wie stark Akku 2 laden oder entladen soll.

2. **BYD2 Ausgangslogik**  
   Wandelt `P_set_aux` in die beiden BYD-Register **InWRte** und **OutWRte** um, inklusive richtiger Vorzeichen, Reihenfolge und Delay.

---

## 1. Gesamtüberblick

### 1.1 BYD2 Hauptlogik

- Arbeitet mit `P_set_aux` in **Watt**.
- Zustandsautomat mit den States:
  - `IDLE`
  - `CHG_SURPLUS` (Laden aus PV-Überschuss)
  - `DIS_BASE` (Entladen zur Grundlastdeckung / Support)
  - `FREEZE` (Failsafe)
- Berücksichtigt:
  - Netzbezug / Einspeisung (`P_grid`)
  - SoC beider Akkus (`SoC_main`, `SoC_aux`)
  - Lade-/Entladeleistung des Haupt- und Aux-Akkus
  - Zellspannung des Aux-Akkus
  - Auto-Freigaben Laden/Entladen
- Liefert:
  - `P_set_aux` (Watt) als Setpoint für Akku 2
  - Debug-Objekt mit allen Zuständen und Messwerten

### 1.2 BYD2 Ausgangslogik

- Wandelt `P_set_aux` → **InWRte / OutWRte** (in %).
- Kümmert sich um:
  - richtige Vorzeichen-Kombination Laden/Entladen
  - Reihenfolge der Register-Schreibungen
  - Delays für negative Werte
  - „0-Stellen“ der Register in sicherer Reihenfolge
- Send-by-Change (SBC) pro Register.

---

## 2. BYD2 Hauptlogik

Datei: [`functions/byd2-main-logic.js`](functions/byd2-main-logic.js)  
Node-RED: Function-Node mit **2 Ausgängen**.

### 2.1 I/O

**Eingang**

- `msg`: Tick-Event (z. B. Inject alle 3 s)
- `msg.payload` wird nicht verwendet, dient nur als Trigger.

**Ausgänge**

- **Output 0:**  
  `msg.payload = P_set_aux` (Number, in W)

  - `> 0` → Akku 2 **laden**
  - `< 0` → Akku 2 **entladen**
  - `0`   → neutral / nichts tun

  Send-by-Change: es wird nur gesendet, wenn sich der Wert um mind. `P_SET_DEADBAND_W` ändert oder das Vorzeichen wechselt / auf 0 geht.

- **Output 1:**  
  `msg.payload = Debug-Objekt`  
  Enthält alle relevanten Zustände (State, SoC, Leistungen, Timer, Limits etc.).  
  Ebenfalls SBC (nur bei Änderungen).

### 2.2 Benötigte globale Variablen

Folgende Werte werden aus `global.get()` gelesen:

- `200.40097_W`  
  Leistung am Netzverknüpfungspunkt  
  - `+` = Netzbezug  
  - `−` = Einspeisung

- `BYD_SoC`  
  SoC Hauptakku in %

- `BYD7.7_SoC`  
  SoC Aux-Akku 2 in %

- `GEN24-8.0_Akku_Laden_W`  
  aktuelle Ladeleistung Hauptakku (W, positiv)

- `GEN24-8.0_Akku_Entladen_W`  
  aktuelle Entladeleistung Hauptakku (W, positiv)

- `GEN24-3.0_Akku_Laden_W`  
  aktuelle Ladeleistung Aux-Akku 2 (W, positiv)

- `GEN24-3.0_Akku_Entladen_W`  
  aktuelle Entladeleistung Aux-Akku 2 (W, positiv)

- `Hausverbrauch_W` (optional)  
  gerechneter Hausverbrauch, wird bevorzugt für DIS_BASE (GRID-Mode) genutzt.

- `OstWest_Freigabe_Akku_Autom_Laden` (Boolean)  
  Auto-Laden Akku 2 erlaubt

- `OstWest_Freigabe_Akku_Autom_Entladen` (Boolean)  
  Auto-Entladen Akku 2 erlaubt

### 2.3 Benötigte Flow-Variablen

Folgende Werte werden aus `flow.get()` gelesen:

- `OstWest_Akku_min_SoC` (Number, %)  
  Minimaler SoC für Entladung von Akku 2, sonst Fallback `SOC_AUX_MIN_DISCHARGE_DEFAULT` (z. B. 5 %).

- `OstWest_Akku_Limit_Charge_Full` (Boolean)  
  `true`: Ladeleistung wird reduziert, wenn Zellspannung hoch ist.

- `byd_1-olli_mVoltMax` (Number, in V)  
  maximale Zellspannung (z. B. `3.428`).

### 2.4 States der State-Machine

- `STATE_IDLE`  
  Kein spezieller Lade-/Entlademodus aktiv, `P_set_aux` geht auf 0.

- `STATE_CHG_SURPLUS`  
  Laden von PV-Überschuss. Ladeleistung wird dynamisch anhand `P_grid` angepasst  
  (Einspeisung → erhöhen, Netzbezug → reduzieren).

- `STATE_DIS_BASE`

  - `DIS_MODE_GRID`: Netzbezug / Grundlast am Netzverknüpfungspunkt reduzieren
  - `DIS_MODE_SUPPORT`: Hauptakku beim Entladen unterstützen (Leistungsteilung nach Kapazitätsverhältnis)

- `STATE_FREEZE`  
  Failsafe bei ungültigen Messwerten → `P_set_aux = 0`.

### 2.5 Wichtige State-Wechsel (Auszug)

**IDLE → CHG_SURPLUS (Laden starten)**

- Auto-Laden freigegeben (`OstWest_Freigabe_Akku_Autom_Laden = true`)
- `SoC_main ≥ SOC_MAIN_MIN_FOR_AUX_CHARGE`
- Hauptakku entlädt nicht stark (`P_main_dis <= MAIN_DISCHARGE_WEAK_W`)
- relevante Einspeisung: `P_grid` deutlich negativ und länger als `CHG_START_DELAY_S`
- kein starker Entladestrom Hauptakku (`P_main_dis <= MAIN_DISCHARGE_STRONG_W`)

**IDLE → DIS_BASE (GRID)**

- Auto-Entladen freigegeben
- `SoC_aux > SOC_AUX_MIN_DISCHARGE`
- relevanter Netzbezug länger als `DIS_START_DELAY_S`

**IDLE → DIS_BASE (SUPPORT)**

- Auto-Entladen freigegeben
- `SoC_aux > SOC_AUX_MIN_DISCHARGE`
- Hauptakku entlädt mit mindestens `MAIN_DIS_SUPPORT_ENTRY_W`

**CHG_SURPLUS → IDLE**

- Auto-Laden nicht freigegeben **ODER**
- `SoC_main < SOC_MAIN_MIN_FOR_AUX_CHARGE` **ODER**
- länger Import / kein Überschuss:  
  `P_grid >= 0` **und** `tImportStop >= CHG_STOP_IMPORT_DELAY_S` **und** `lastPset === 0`

**DIS_BASE → IDLE**

- Auto-Entladen nicht freigegeben **ODER**
- `SoC_aux <= Min-SoC` **ODER**
- `DIS_MODE_GRID`: `P_grid <= 0`  
- `DIS_MODE_SUPPORT`: `P_main_dis < MAIN_DIS_SUPPORT_EXIT_W`

### 2.6 `P_set_aux` – Berechnung (Kurzfassung)

**Laden (`STATE_CHG_SURPLUS`)**

- Korrektur aus `P_grid`:

  ```js
  if (P_grid < -GRID_TOLERANCE_W)      // Einspeisung
      P_surplus = -P_grid;             // mehr laden
  else if (P_grid > GRID_TOLERANCE_W)  // Netzbezug
      P_surplus = -P_grid;             // weniger laden
  else
      P_surplus = 0;
Ziel:

P_target = P_aux_chg + P_surplus;
P_target = clamp(P_target, 0, AUX_WR_AC_MAX_W, effectiveMaxChargeW);
P_set_aux_new = P_target;  // > 0 = Laden


effectiveMaxChargeW berücksichtigt:

Basislimit MAX_CHG_POWER_W

Zellspannungs-Limit (AUX_MAX_CELL_V + AUX_MAX_CHARGE_FULL_W, wenn aktiv)
  
Entladen (STATE_DIS_BASE)

GRID-Modus: Grundlast / Import reduzieren

P_base_need = ... // aus Hausverbrauch oder P_grid
P_set_aux_new = -target; // < 0 = Entladen


SUPPORT-Modus: Entladeleistung auf beide Akkus aufteilen

P_aux_target_raw = P_main_dis_pos / MAIN_TO_AUX_CAP_RATIO;
P_aux_target     = min(P_aux_target_raw, AUX_WR_AC_MAX_W);
P_aux_target     = roundTo(SUPPORT_STEP_W);


Mit Hysterese SUPPORT_TARGET_HYST_W, damit nicht dauernd zwischen Stufen gesprungen wird.

2.7 Rampe / Dynamik

Getrennte Rampen für Laden und Entladen:

Laden

AUX_P_DELTA_MAX_CHG_W: max. Schritt (W)

RAMP_MIN_HOLD_CHG_S: min. Zeit zwischen zwei „größer werden“-Schritten

Entladen

AUX_P_DELTA_MAX_DIS_W: max. Schritt (W)

RAMP_MIN_HOLD_DIS_S: min. Zeit zwischen zwei „größer werden“-Schritten

Support-Mode wird zusätzlich „gehalten“, um schnelle Änderungen zu vermeiden.

2.8 Node-Status & Debug

Node-Status (Farbe)

grau: IDLE

grün: CHG_SURPLUS

gelb: DIS_BASE (GRID)

orange: DIS_BASE (SUPPORT)

rot: FREEZE

Text-Beispiele

CHG (LIM) F:LD P=1200W Pg=-300W SoC_main=65%

DIS_SUPPORT F:D P=-700W Pg=50W SoC_aux=40%

F: zeigt Freigaben:

F:LD → Laden & Entladen freigegeben

F:L → nur Laden

F:D → nur Entladen

F:- → keine Freigaben

Debug-Objekt (2. Ausgang)

Beinhaltet u. a.:

state, stateBase, disMode

P_grid, P_house

SoC_main, SoC_aux, socAuxMinDischarge

P_main_chg, P_main_dis, P_aux_chg, P_aux_dis

auxChargeEnable, auxDischargeEnable

tGridImportHigh, tGridExportHigh, tImportStop, tStateHold

P_set_aux, lastSupportTarget

chargeLimitActive, auxLimitFullEnable, auxCellMaxV, effectiveMaxChargeW

failsafeReason (falls aktiv)

3. BYD2 Ausgangslogik

Datei: functions/byd2-output-logic.js

Node-RED: Function-Node mit 2 Ausgängen hinter der Hauptlogik.

3.1 I/O

Eingang

msg.payload = P_set_aux (Integer, W)

> 0 → Laden erzwingen

< 0 → Entladen erzwingen

0 → neutral / freigeben

Ausgänge

Output 0: InWRte (Number, % mit 1 Nachkommastelle)

Output 1: OutWRte (Number, % mit 1 Nachkommastelle)

Beide Ausgänge sind Send-by-Change (nur senden bei Wertänderung).

3.2 Bedeutung der Register (BYD-Logik, vereinfacht)

Laden erzwingen

InWRte > 0

OutWRte < 0

Betrag von OutWRte bestimmt Ladegrad (negativ)

Entladen erzwingen

OutWRte > 0

InWRte < 0

Betrag von InWRte bestimmt Entladegrad (negativ)

3.3 Internes Verhalten

P_set_aux lesen & filtern

Konvertiert nach Number

kleine Werte (|P| < 10 W) → 0

% aus P_set_aux berechnen

relativ zu AUX_BAT_MAX_W (Setpoint max charge)

Ergebnis als Betrag in % (0…100, 1 Nachkommastelle)

Modus bestimmen

P_set_aux > 0 → CHG

P_set_aux < 0 → DIS

P_set_aux = 0 → Spezialfall (siehe unten)

0-Spezialfall

Wenn P_set_aux = 0:

War InWRte < 0 → zuerst InWRte = 0, dann OutWRte = 0 mit Delay

War OutWRte < 0 → zuerst OutWRte = 0, dann InWRte = 0 mit Delay

Keiner negativ → beide auf 0 ohne Delay

Damit werden „Illegal Value“-Fehler bei Richtungswechseln/Freigabe vermieden.

Nicht-Null-Fall

Laden (CHG):

InWRte  = +X
OutWRte = -X


Reihenfolge/Delay:

Leistung hoch: zuerst In (sofort), dann Out (mit Delay)

Leistung runter: zuerst Out, dann In (mit Delay)

Entladen (DIS):

OutWRte = +X
InWRte  = -X


Reihenfolge/Delay:

Leistung hoch: zuerst Out, dann In (mit Delay)

Leistung runter: zuerst In, dann Out (mit Delay)

Delay / Reihenfolge

negative Werte und „zweite Schritte“ bei 0-Stellung bekommen msg.delay = NEG_DELAY_MS (z. B. 500 ms)

dahinter: Delay-Node, der msg.delay als Verzögerung nutzt.

Node-Status

zeigt immer: P=…W In=…% Out=…%

schnell ersichtlich, ob Ausgabe zur Hauptlogik passt.

4. Tuning-Tipps

Laden zu träge?

AUX_P_DELTA_MAX_CHG_W erhöhen

RAMP_MIN_HOLD_CHG_S verkleinern

Entladen zu nervös?

AUX_P_DELTA_MAX_DIS_W verkleinern

RAMP_MIN_HOLD_DIS_S vergrößern

BASELOAD_TARGET_W / GRID_TOLERANCE_W anpassen

SUPPORT-Modus „zittert“?

SUPPORT_STEP_W erhöhen

SUPPORT_TARGET_HYST_W erhöhen

Ladung bei „voll“ zu aggressiv?

AUX_MAX_CELL_V etwas niedriger setzen



AUX_MAX_CHARGE_FULL_W kleiner wählen

5. Nutzung in Node-RED

Inhalte aus functions/byd2-main-logic.js und functions/byd2-output-logic.js in entsprechende Function-Nodes kopieren.

Verkabelung:

Hauptlogik Output 0 → Ausgangslogik Input

Hauptlogik Output 1 → Debug/MQTT/Log

msg.delay am Ausgang der zweiten Funktion über einen Delay-Node auswerten (Modus „Delay set in msg.delay“).

Optional: kompletten Flow-Tab exportieren und als flows/byd2-aux-flow.json ablegen.
