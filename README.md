# Node-RED: Automatische Lade-/Entlade-Steuerung für zweiten BYD-Akku

Dieses Projekt enthält eine Node-RED-Logik zur automatischen Steuerung eines zweiten BYD-Speichers
(z. B. kleiner WR an einer Ost/West-Anlage), basierend auf:

- Netzbezug / Einspeisung (Smart Meter)
- SoC von Haupt- und Nebenakku
- Lade-/Entladeleistung des Hauptakkus
- Zellspannung Akku 2
- Freigaben aus der Visualisierung (Gira)

Ziele:

- PV-Überschüsse in Akku 2 laden (CHG_SURPLUS)
- Grundlast und/oder Hauptakku beim Entladen unterstützen (DIS_BASE)
- sanfte Rampen + Hysterese
- BYD-Register **InWRte / OutWRte** sauber und ohne Modbus-Fehler beschreiben

## 1. Architektur

Der Flow besteht im Kern aus drei Function-Nodes plus ein paar ioBroker-I/O-Knoten:

1. **DIE 2. Akku Steuerung V4**  
   _Hauptlogik_
   - arbeitet auf Watt-Basis (`P_set_aux` in W)
   - State-Machine (`IDLE`, `CHG_SURPLUS`, `DIS_BASE`, `FREEZE`)
   - berücksichtigt:
     - Netzverknüpfungspunkt (`P_grid`)
     - SoC Hauptakku (`BYD_SoC`)
     - SoC Akku 2 (`BYD7.7_SoC`)
     - Lade-/Entladeleistung Haupt- und Nebenakku
     - Freigaben & Zellspannung

2. **DIE Ausgangs Logik V2**  
   _BYD-Ausgangslogik_
   - Input: `P_set_aux` (W)
   - Output: **InWRte / OutWRte** in % (1 Nachkommastelle)
   - implementiert BYD-Logik:
     - Laden erzwingen:    `InWRte > 0`, `OutWRte < 0`
     - Entladen erzwingen: `InWRte < 0`, `OutWRte > 0`
   - sorgt für korrekte Reihenfolge + Delay, damit keine „Illegal Value“-Fehler auftreten

3. **Visu Status Text** + **OstWest_Funktion_Status_txt**
   - Debug-Objekt → kompakter Status-String für Gira (CO@…)
   - send-by-change, damit die Visu nicht gespammt wird

Dazu kommen:

- `ioBroker in` für Freigaben & Parameter aus Gira / Modbus
- `ioBroker out` auf die BYD-Register `40365_OutWRte` und `40366_InWRte`
- ein `inject`-Node, der alle 3 s triggert

## 2. Flow-Import

Der komplette Flow liegt als Node-RED-JSON (Gruppe „Automatische Lade / Entlade steuerung“)
mit u. a.:

- `DIE 2. Akku Steuerung V4` (Function)
- `DIE Ausgangs Logik V2` (Function)
- Delay-Nodes für `msg.delay`
- ioBroker I/O-Knoten
- Kommentar-Node „Funktionsbeschreibung“

### 2.1 Import in Node-RED

1. JSON-Export des Flows aus diesem Repository kopieren.
2. In Node-RED: **Menü → Import → Clipboard** → JSON einfügen.
3. Ziel: **Neuer Flow** auswählen, importieren.
4. Danach:
   - ioBroker-Topics ggf. an deine Instanz anpassen (Adapter-ID, Index).
   - Deploy.

## 3. Ein-/Ausgänge der Hauptlogik

- **Trigger**
  - `inject`-Node „Alle 3 Sekunden“
  - `msg.payload` wird ignoriert, dient nur als Takt

- **Output 0 – P_set_aux (W)**
  - `msg.payload` = Leistung für Akku 2
    - `> 0` → Laden
    - `< 0` → Entladen
    - `= 0` → neutral
  - send-by-change mit Deadband `P_SET_DEADBAND_W`
    (kleine Änderungen werden unterdrückt, 0-/Vorzeichenwechsel wird immer gesendet)

- **Output 1 – Debug-Objekt**
  - enthält alle relevanten Zustände (State, SoC, Leistungen, Timer, Limits, Failsafe)
  - wird nur bei Änderungen gesendet (SBC)

## 4. Benötigte Variablen

### 4.1 Globale Variablen (`global.get`)

| Key                                   | Bedeutung                                          |
|---------------------------------------|----------------------------------------------------|
| `200.40097_W`                         | P am Netzverknüpfungspunkt (+Bezug, −Einspeisung)  |
| `BYD_SoC`                             | SoC Hauptakku (%)                                  |
| `BYD7.7_SoC`                          | SoC Akku 2 (%)                                     |
| `GEN24-8.0_Akku_Laden_W`             | Ladeleistung Hauptakku (W, positiv)                |
| `GEN24-8.0_Akku_Entladen_W`          | Entladeleistung Hauptakku (W, positiv)             |
| `GEN24-3.0_Akku_Laden_W`             | Ladeleistung Akku 2 (W, positiv)                   |
| `GEN24-3.0_Akku_Entladen_W`          | Entladeleistung Akku 2 (W, positiv)                |
| `Hausverbrauch_W` (optional)         | berechneter Hausverbrauch                          |
| `OstWest_Freigabe_Akku_Autom_Laden`  | Auto-Laden freigegeben (bool)                      |
| `OstWest_Freigabe_Akku_Autom_Entladen` | Auto-Entladen freigegeben (bool)                 |

### 4.2 Flow-Variablen (`flow.get`)

| Key                              | Bedeutung                                           |
|----------------------------------|-----------------------------------------------------|
| `OstWest_Akku_min_SoC`           | Minimaler SoC für Entladen Akku 2 (%)              |
| `OstWest_Akku_Limit_Charge_Full` | Limit bei fast voll aktiv (Zellspannung) (bool)    |
| `byd_1-olli_mVoltMax`            | maximal gemessene Zellspannung Akku 2 (V, 3 Stellen) |

## 5. State-Machine

### 5.1 Zustände

- `IDLE`  
  - kein aktives Laden/Entladen, P langsam Richtung 0

- `CHG_SURPLUS`  
  - PV-Überschuss in Akku 2 laden

- `DIS_BASE`  
  - Akku 2 entlädt
  - Modi:
    - `GRID` → Netzbezug/Grundlast reduzieren
    - `SUPPORT` → Hauptakku beim Entladen entlasten

- `FREEZE`  
  - Failsafe bei ungültigen Werten (SoC/Leistungen ungültig)  
  - P → 0, bis Werte wieder plausibel

### 5.2 Typische Übergänge (vereinfacht)

- `IDLE → CHG_SURPLUS`
  - Auto-Laden frei, SoC Hauptakku hoch genug,
  - Hauptakku entlädt nicht stark,
  - relevanter Export über `CHG_START_DELAY_S`.

- `IDLE → DIS_BASE (GRID)`
  - Auto-Entladen frei,
  - SoC Akku 2 > Min-SoC,
  - relevanter Import über `DIS_START_DELAY_S`.

- `IDLE → DIS_BASE (SUPPORT)`
  - Auto-Entladen frei,
  - SoC Akku 2 > Min-SoC,
  - Hauptakku entlädt über `MAIN_DIS_SUPPORT_ENTRY_W`.

- Zurück nach `IDLE`
  - Freigaben weg, SoC zu niedrig oder kein Import/Support-Bedarf mehr.

## 6. Berechnung von P_set_aux (vereinfacht)

### 6.1 CHG_SURPLUS (Laden)

- Korrektur basiert auf `P_grid`:
  - Einspeisung → Ladeleistung erhöhen
  - Netzbezug → Ladeleistung reduzieren
  - nahe 0 → Ladeleistung halten

- Zielgröße:

    P_target = P_aux_chg + P_surplus        // Ist-Laden + Korrektur
    if (P_target < 0) P_target = 0

    P_target = min(
        P_target,
        AUX_WR_AC_MAX_W,
        effectiveMaxChargeW   // C-Rate + Zellspannungs-Limit
    )

    P_set_aux_new = P_target                 // > 0 = Laden


### 6.2 DIS_BASE (Entladen)

- GRID-Modus (Netzbezug / Grundlast reduzieren):

    if (P_house vorhanden):
        P_base_need = min(P_house, BASELOAD_TARGET_W)
    else:
        P_base_need = min(max(P_grid, 0), BASELOAD_TARGET_W)

    target        = min(P_base_need, BASELOAD_TARGET_W, AUX_WR_AC_MAX_W)
    P_set_aux_new = -round(target)          // < 0 = Entladen

- SUPPORT-Modus (Hauptakku entlasten):

    P_main_dis_pos   = max(P_main_dis, 0)
    P_aux_target_raw = P_main_dis_pos / MAIN_TO_AUX_CAP_RATIO
    P_aux_target     = min(P_aux_target_raw, AUX_WR_AC_MAX_W)

    // auf SUPPORT_STEP_W runden + Hysterese via SUPPORT_TARGET_HYST_W

    if (P_aux_target < SUPPORT_STEP_W):
        P_set_aux_new = 0
    else:
        P_set_aux_new = -P_aux_target

## 7. Rampe & Dynamik

- Getrennte Rampen für **Laden** und **Entladen**:

  - Laden:
    - max. Schritt: `AUX_P_DELTA_MAX_CHG_W`
    - min. Haltezeit: `RAMP_MIN_HOLD_CHG_S`
  - Entladen:
    - max. Schritt: `AUX_P_DELTA_MAX_DIS_W`
    - min. Haltezeit: `RAMP_MIN_HOLD_DIS_S`

- Logik:
  - Wenn der Betrag von `P_set_aux_new` größer werden soll:
    - nur alle `rampHoldMinS` Sekunden erhöhen
  - Wenn der Betrag kleiner wird:
    - schneller nachführen (bis max. `AUX_P_DELTA_MAX_*_W` je Tick)

- SUPPORT-Modus:
  - zusätzliche Halte-Logik, damit nicht dauernd zwischen Stufen gewechselt wird.

- Kleinkram:
  - `|P_set_aux| < 10 W` → auf 0 geklemmt
  - Begrenzung auf `[-AUX_WR_AC_MAX_W, +AUX_WR_AC_MAX_W]`.

## 8. BYD-Ausgangslogik (InWRte / OutWRte)

Funktion: **DIE Ausgangs Logik V2**

- Input: `P_set_aux` (W)
- Output:
  - `InWRte` (%), 1 Nachkommastelle
  - `OutWRte` (%), 1 Nachkommastelle
- Umrechnung:
  - Prozent relativ zu `AUX_BAT_MAX_W`
  - Werte werden auf ±100 % begrenzt und auf 0,1 % gerundet.

### 8.1 Modus / Mapping

- `P_set_aux > 0` → **Laden (CHG)**  
  - `InWRte = +X`, `OutWRte = -X`

- `P_set_aux < 0` → **Entladen (DIS)**  
  - `OutWRte = +X`, `InWRte = -X`

- `P_set_aux = 0` → **geordnete 0-Sequenz**:
  - war `InWRte < 0` → erst `InWRte = 0`, dann `OutWRte = 0` mit Delay
  - war `OutWRte < 0` → erst `OutWRte = 0`, dann `InWRte = 0` mit Delay
  - sonst beide direkt auf 0

Damit wird sichergestellt, dass BYD bei Richtungswechseln / Freigabe
keine „Illegal Value“-Fehler wirft.

### 8.2 Delay & SBC

- Schritte, in denen negative Werte geschrieben werden oder die zweite 0-Stufe:
  - `msg.delay = NEG_DELAY_MS` (z. B. 500 ms).
- Hinter der Funktion hängt ein `delay`-Node mit „delayv“-Modus.
- In/Out werden nur bei Änderung gesendet (send-by-change).
- Node-Status:
  - `P=…W  In=…%  Out=…%` zur schnellen Kontrolle.

### 8.3 Hinweis Fronius GEN24 (StorCtl_Mod)

Damit die Vorgaben über **InWRte / OutWRte** am Fronius GEN24 überhaupt wirksam werden,
muss das Modbus-Register

- `40358_StorCtl_Mod`

mit dem Wert **3** beschrieben werden.

Nur dann sind beide Grenzwerte (Laden/Entladen) aktiv und der WR folgt den
erzwungenen Vorgaben aus `InWRte` / `OutWRte`.

## 9. Visualisierung (Gira)

### 9.1 Visu Status Text

Function-Node **„Visu Status Text“**:

- Input: Debug-Objekt (2. Ausgang der Hauptlogik)
- Output: kompakter String, z. B.:

    Mode=CHG_SURPLUS | Akku=1200W

- Konfigurierbare Felder (Array `FIELDS` im Code, z. B. `state`, `P_set_aux`).
- send-by-change:
  - Text wird nur gesendet, wenn er sich ändert.
- Node-Status zeigt denselben Text.

### 9.2 Gira Endpoint

Function-Node **„OstWest_Funktion_Status_txt“**:

- Baut aus dem Status-String ein JSON für den `gira-endpoint`-Adapter.
- Key: `CO@OstWest_Funktion_Status_txt`
- `msg.payload` enthält:
  - `type: "call"`
  - `param.key`: `CO@OstWest_Funktion_Status_txt`
  - `param.method`: `"set"`
  - `param.value`: Text

So steht der aktuelle Betriebszustand in der Gira-Visu zur Verfügung
(z. B. als Textfeld unter dem Akku-Symbol).

## 10. Tuning

Typische Stellschrauben in der Hauptfunktion:

- **Laden zu träge?**
  - `AUX_P_DELTA_MAX_CHG_W` erhöhen (größere Leistungsschritte)
  - `RAMP_MIN_HOLD_CHG_S` verkleinern (schneller nachregeln)

- **Entladen zu nervös?**
  - `AUX_P_DELTA_MAX_DIS_W` verkleinern
  - `RAMP_MIN_HOLD_DIS_S` vergrößern
  - ggf. `BASELOAD_TARGET_W` und `GRID_TOLERANCE_W` anpassen

- **SUPPORT-Modus „zittert“ zwischen Stufen?**
  - `SUPPORT_STEP_W` erhöhen (gröbere Stufen)
  - `SUPPORT_TARGET_HYST_W` erhöhen (größere Hysterese)
