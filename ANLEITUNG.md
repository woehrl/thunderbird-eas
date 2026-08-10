# Anleitung — Thunderbird EAS Connector

Schritt-für-Schritt-Anleitung von der Installation bis zum laufenden Postfach.

> **Vorweg, weil es die häufigste Verwirrung ist:** Das Konto wird **nicht** über Thunderbirds
> Konto-Assistenten eingerichtet. Der Assistent (*Konto hinzufügen → E-Mail*) kennt nur IMAP, POP3
> und Thunderbirds eingebautes EWS — Exchange ActiveSync kommt dort nicht vor und wird auch nie
> dort auftauchen. Das Add-on bringt eine **eigene Einrichtungsseite** mit, siehe [Schritt 4](#schritt-4--konto-einrichten).

---

## Schritt 0 — Vorher: EWS prüfen (ernsthaft)

Thunderbird kann seit 2024/2025 **von Haus aus** mit Exchange sprechen, über EWS. Kein Add-on, keine Gerätepartnerschaft, keine Freigabe durch den Administrator, kein Gerätekontingent. Wenn das Postfach über EWS erreichbar ist, ist das in jeder Hinsicht der bessere Weg.

### 0a — Die richtige EWS-URL erfragen

Nicht raten. Autodiscover verrät sie, ohne Zugangsdaten, in einem Aufruf. In PowerShell:

```powershell
$mail = 'vorname@firma.org'
$dom  = $mail.Split('@')[1]
foreach ($p in 'Ews','ActiveSync') {
  $u = "https://autodiscover.$dom/autodiscover/autodiscover.json/v1.0/$mail`?Protocol=$p"
  try { "{0,-12} {1}" -f $p, (Invoke-WebRequest $u -UseBasicParsing -TimeoutSec 20).Content }
  catch { "{0,-12} {1}" -f $p, $_.Exception.Message }
}
```

Antwort für EWS sieht so aus:

```json
{"Protocol":"Ews","Url":"https://mail.firma.org/EWS/Exchange.asmx"}
```

**Der Hostname aus der Zertifikats-SAN-Liste ist nicht verlässlich.** In einem real gemessenen Fall stand dort `ews.<domain>`, dieser Name hatte aber überhaupt keinen DNS-Eintrag — der echte Endpunkt lag unter `mail.<domain>`. Wer die SAN-Liste als Adressquelle nimmt, testet ins Leere und bekommt eine irreführende Fehlermeldung.

### 0b — In Thunderbird eintragen

*Konten → Konto hinzufügen → E-Mail* → Adresse und Kennwort → *Manuell einrichten* → Protokoll **EWS**.

Ins Feld „URL des Exchange-Endpunkts" gehört die **vollständige URL** aus Schritt 0a, also mit `/EWS/Exchange.asmx` am Ende. Nur der Host (`https://mail.firma.org`) wird mit *„Bitte geben Sie eine gültige Adresse ein"* abgelehnt — das ist die häufigste Stolperfalle in diesem Dialog.

Authentifizierungsmethode: **Passwort, normal**. Benutzername: die volle SMTP-Adresse.

### 0c — Ergebnis deuten

| Antwort | Bedeutung |
|---|---|
| Konto wird angelegt | Fertig. Diese Anleitung ab hier ignorieren. |
| „Fehler bei der Authentifizierung" | Mehrdeutig — Thunderbird meldet so auch Verbindungsfehler. Weiter mit 0d. |

### 0d — Gesperrt oder falsch angemeldet?

Thunderbirds Fehlermeldung unterscheidet nicht zwischen „Kennwort falsch" und „Zugriff gesperrt". Der Server tut das sehr wohl, im 401/403 einer **unauthentifizierten** Anfrage:

```powershell
$url = 'https://mail.firma.org/EWS/Exchange.asmx'   # aus Schritt 0a
try { Invoke-WebRequest $url -UseBasicParsing -TimeoutSec 20 | Out-Null }
catch {
  $r = $_.Exception.Response
  "HTTP $([int]$r.StatusCode)"
  foreach ($k in $r.Headers.AllKeys) { if ($k -eq 'WWW-Authenticate') { $r.Headers.GetValues($k) } }
}
```

| Ausgabe | Bedeutung |
|---|---|
| `HTTP 401` + `WWW-Authenticate: Basic …` | Der Server will Basic-Anmeldung → Zugangsdaten oder Benutzernamensform prüfen |
| `HTTP 401` + nur `Negotiate` / `NTLM` | Basic ist abgeschaltet. Thunderbirds EWS kann nur Basic und OAuth2 → **EWS unbrauchbar** |
| `HTTP 403`, **kein** `WWW-Authenticate` | Keine Anmeldeaufforderung, sondern eine Abweisung. Das EWS-Verzeichnis ist gesperrt → **EWS unbrauchbar** |
| Name lässt sich nicht auflösen | Falscher Hostname, zurück zu Schritt 0a |

Zum Vergleich lohnt derselbe Aufruf gegen den EAS-Endpunkt. Kommt dort `HTTP 401` mit `WWW-Authenticate: Basic realm="…"`, ist Basic-Auth für EAS freigeschaltet und der Weg über dieses Add-on offen.

Das Add-on hat den EWS-Test ebenfalls eingebaut (Knopf **Check for EWS first**), falls Du ihn lieber von dort ausführst.

---

## Schritt 1 — Welchen Build nehmen?

Aus demselben Quellcode entstehen zwei `.xpi`-Dateien:

| Build | Was Du bekommst | Aufwand |
|---|---|---|
| **Standard** | Mails landen in einem Ordner unter *Lokale Ordner*. Kennwort liegt im Add-on-Speicher. | Sofort installierbar |
| **Privileged** | Eigener Konto-Knoten oben im Ordnerbaum wie bei IMAP, richtige Sonderordner-Symbole, Kennwort im Thunderbird-Passwortmanager | Einmalig eine `about:config`-Einstellung |

Empfehlung: **Privileged**. Der Mehraufwand ist ein Doppelklick.

### Bauen

```bash
cd thunderbird-eas
node package.js --privileged
```

Die Datei landet in `dist/` und heißt `thunderbird-eas-1.1.0-privileged-<zeitstempel>.xpi`.

Das Packaging führt vorher automatisch den Protokoll-Selbsttest aus. Wenn der fehlschlägt, wird nicht gebaut — das ist Absicht, siehe [DEVELOPMENT.md](DEVELOPMENT.md).

---

## Schritt 2 — Vorbereitung für den Privileged-Build

Nur nötig, wenn Du den Privileged-Build nimmst. **Vor** der Installation erledigen.

1. Thunderbird → **Extras → Einstellungen → Allgemein**
2. Ganz nach unten scrollen → **Konfiguration bearbeiten…**
3. Warnung bestätigen
4. Suchen nach `extensions.experiments.enabled`
5. Doppelklick, bis der Wert **`true`** ist
6. Fenster schließen

> **Warum?** Der Manifest-Schlüssel `experiment_apis` wird beim Laden der Erweiterung ausgewertet und kann nicht nachträglich angefordert werden. Steht die Einstellung auf `false`, **verweigert Thunderbird die Installation der gesamten Erweiterung** — nicht nur der privilegierten Funktion. Deshalb zuerst die Einstellung, dann installieren.

---

## Schritt 3 — Installieren

1. **Extras → Add-ons und Themes**
2. Zahnrad oben rechts → **Add-on aus Datei installieren…**
3. Die `.xpi` aus `dist/` auswählen (die mit Zeitstempel, nicht den Ordner)
4. Bestätigen

Falls Thunderbird die Installation mit „konnte nicht verifiziert werden" ablehnt: Die Erweiterung ist nicht signiert. In `about:config` `xpinstall.signatures.required` auf `false` setzen, dann erneut installieren.

---

## Schritt 4 — Konto einrichten

### Wo ist die Einrichtungsseite?

Nach der Installation öffnet sie sich einmalig von selbst. Danach gibt es drei Wege, vom
zuverlässigsten zum umständlichsten:

| # | Weg |
|---|---|
| 1 | **Extras → Exchange ActiveSync accounts…** |
| 2 | **Extras → Add-ons und Themes → Erweiterungen** → bei *Thunderbird EAS Connector* auf das **🔧-Symbol** (Tooltip *„Optionen für Add-ons"*) |
| 3 | Symbolleisten-Schaltfläche **EAS Sync** → *Settings* (muss erst eingeblendet werden, siehe unten) |

Zu Weg 2: Der Schraubenschlüssel sitzt zwischen dem Ein/Aus-Schalter und dem `…`-Menü.
Nicht im `…`-Menü suchen — das enthält nur *Entfernen* und *Verwalten*. Und nicht in der
Detailansicht: dort gibt es nur die Reiter *Details* und *Berechtigungen*.

### Wenn der Schraubenschlüssel grau ist

Dann konnte die Erweiterung ihre Hintergrundseite nicht starten. Die Optionsseite gehört zur
Erweiterung — läuft die nicht, gibt es nichts zu öffnen. Auch der Menüeintrag aus Weg 1 fehlt dann.

**Strg+Umschalt+J** öffnet die Fehlerkonsole. Dort steht die Ursache. Drei bekannte Muster:

| Meldung | Ursache |
|---|---|
| `api.onStartup is not a function` und `Exception running bootstrap method startup on thunderbird-eas@woehrl.biz` | Der Experiment-Block deklariert `"events": ["startup"]`, die API-Klasse hat aber keine `onStartup()`-Methode. Behoben ab Version 1.1.0 — mit einem älteren Build neu paketieren und installieren. |
| `redeclaration of const Cc` o. ä. beim Laden von `implementation.js` | `Cc`, `Ci` und `Services` sind im Experiment-Sandkasten bereits globale Namen und dürfen nicht erneut deklariert werden. |
| Erweiterung wird gar nicht installiert | `extensions.experiments.enabled` stand beim Installieren nicht auf `true` (Schritt 2). |

Gegenprobe, wenn die Meldung unklar bleibt: den **Standard-Build** installieren
(`node package.js` ohne `--privileged`). Läuft der, liegt es am Experiment-Teil.

Notfallweg, falls die Seite trotzdem gebraucht wird: **Extras → Entwicklerwerkzeuge → Add-ons
debuggen** zeigt zu jeder Erweiterung eine *Manifest-URL* der Form
`moz-extension://<kennung>/manifest.json`. Diese URL in einen Tab kopieren und `manifest.json`
durch `ui/setup/setup.html` ersetzen.

### Optional: Schaltfläche in die Symbolleiste holen

Die Erweiterung bringt eine Schaltfläche **EAS Sync** mit (Statusanzeige und *Sync All*), die aber standardmäßig **nicht eingeblendet** ist. Zum Aktivieren:

Rechtsklick auf die Symbolleiste → **Anpassen…** → das Symbol der Erweiterung in die Leiste ziehen → **Fertig**.

Danach kommt man über *EAS Sync → Settings* ebenfalls auf die Einrichtungsseite, und die Statusanzeige aus [Schritt 6](#schritt-6--statusanzeige-lesen) ist erreichbar.

### Was der Standard-Assistent zeigt, gehört nicht hierher

Thunderbirds Assistent *Konto hinzufügen → E-Mail* bietet IMAP, POP3 und **Exchange (EWS)** an — das ist Thunderbirds eigene Exchange-Unterstützung, nicht dieses Add-on. Ist EWS nutzbar, nimm sie (siehe Schritt 0). Ist sie es nicht, schließe den Assistenten und arbeite ausschließlich auf der Seite des Add-ons weiter.

Zwei Dinge, die dort irritieren können:

- Der Assistent schlägt manchmal aus **Mozillas ISPDB** eine Konfiguration vor, etwa `outlook.office365.com` mit OAuth2. Das ist ein hinterlegter Eintrag für die Domäne, kein Ergebnis einer Abfrage Deines Servers, und kann Deinem Postfach widersprechen. Maßgeblich ist, was der Autodiscover Deiner Domäne liefert (Schritt 0a).
- Der Eintrag **„Exchange — ADD-ON ERFORDERLICH"** verweist auf kommerzielle Fremd-Add-ons. Dieses Add-on klinkt sich dort nicht ein.

### Die Felder

Die Einrichtungsseite von oben nach unten.

### Prüfen: welcher Build läuft?

Im Kasten *Configured Accounts* steht unten ein farbiger Hinweis:

- **Grün** „Privileged build active…" → alles richtig gemacht
- **Gelb** „Standard build…" → Du hast den Standard-Build installiert, oder die `about:config`-Einstellung fehlte

### Felder ausfüllen

| Feld | Inhalt | Anmerkung |
|---|---|---|
| **Username / Email** | Volle SMTP-Adresse, z. B. `vorname@firma.org` | Der Anmeldename. Kein `DOMÄNE\benutzer` |
| **Your Name** | Dein Name, z. B. `Florian Wöhrl` | Erscheint als Absender auf ausgehenden Mails |
| **Password** | Kennwort | Landet im Privileged-Build im Passwortmanager |
| **EAS Server** | **leer lassen** | Wird im nächsten Schritt gefüllt |

Unter **Advanced** gibt es zusätzlich **Mailbox address**. Das Feld bleibt in aller Regel leer —
es wird nur gebraucht, wenn der Anmeldename *keine* Adresse ist (etwa ein reiner Kontoname).
Dort gehört eine Adresse hinein, kein Name.

### Server suchen

Knopf **Find server** drücken.

Das Add-on fragt zuerst Autodiscover V2 (ein unauthentifizierter GET, der bei modernen Exchange-Servern funktioniert), dann Autodiscover POX mit vier Kandidaten-URLs parallel. Das Ergebnis landet im Feld *EAS Server*.

Im schwarzen Protokollfeld darunter siehst Du, was passiert ist. Drei mögliche Ausgänge:

| Meldung | Bedeutung |
|---|---|
| „Found … via autodiscover-v2" | Bestes Ergebnis, direkt weiter |
| „Found … via autodiscover-pox" | Auch gut |
| „guessed …" (gelb) | Autodiscover hat nichts geliefert, geraten wurde `eas.<domain>`. **Test Connection** ist jetzt Pflicht. |

Wenn Du den Hostnamen kennst, kannst Du ihn auch direkt eintippen — **ohne** `https://`, ohne Pfad, ohne Portnummer. Also `eas.firma.org`, nicht `https://eas.firma.org/Microsoft-Server-ActiveSync`.

### Geräteprofil wählen

Das ist die wichtigste Entscheidung auf dieser Seite.

Exchange kann Clients anhand von `DeviceType` und `User-Agent` sperren (Allow/Block/Quarantine-Regel), und es begrenzt die Zahl der Gerätepartnerschaften pro Postfach — meist auf fünf.

| Profil | Empfehlung |
|---|---|
| **Thunderbird** | **Standard.** Sagt, was es ist. Gegen den Referenzserver erfolgreich. |
| **Outlook Desktop (Windows)** | Nachahmung. Rückfallebene, wenn der Server nur bekannte Clients zulässt. Verhandelt 14.0, weil echtes Outlook das tut. |
| **iPhone (iOS Mail)** | Zweite Nachahmung, ebenfalls akzeptiert |
| **Android Mail** | Nachahmung, nicht gegen den Referenzserver geprüft |
| **Custom…** | Nur wenn Du einen Wert kennst, der beim Server durchgeht |

Das Standardprofil sendet den User-Agent `Thunderbird-EAS/1.0` — **ohne** Thunderbird-Versionsnummer.
Das ist Absicht: Server dürfen den User-Agent laut Spezifikation über Requests hinweg verfolgen und
Geräte sperren, die ihn zu oft ändern, und Thunderbirds Version ändert sich mit jedem Update. Die
laufende Version wird stattdessen als Gerätename übermittelt und erscheint in der OWA-Geräteliste
als `Thunderbird 153.0.2 (adresse@firma.org)` — dort sind Änderungen vorgesehen.

> **Wichtig:** Exchange identifiziert ein Gerät über `DeviceId` **und** `DeviceType`. Wechselst Du das Profil später, entsteht eine **zusätzliche** Gerätepartnerschaft und verbraucht einen weiteren Platz des Kontingents. Der alte Eintrag muss in OWA von Hand gelöscht werden. Also lieber einmal richtig wählen.

### Erweiterte Einstellungen (optional)

Aufklappen über **Advanced**.

| Option | Wann anfassen |
|---|---|
| **Poll interval** | Abrufintervall in Minuten, wenn Push aus ist. 5 ist sinnvoll. |
| **Sync messages from** | Begrenzt, wie weit der Erstabgleich zurückreicht. Bei sehr großen Postfächern erst *Last month* nehmen, später auf *All* stellen. |
| **Credential encoding** | Nur bei Umlauten im Kennwort relevant. Wenn ein korrektes Kennwort als falsch abgelehnt wird: auf *ISO-8859-1* stellen. Das ist die Kodierung, die echtes Outlook sendet. |
| **Push (Ping)** | An lassen. Der Server hält die Verbindung offen und meldet Änderungen sofort. |
| **Device ID** | Leer lassen erzeugt eine neue. Trägst Du eine vorhandene ein, hängt sich das Konto an eine Gerätepartnerschaft, die der Server schon kennt — sinnvoll nach einer Neuinstallation oder in einem zweiten Profil. Spart einen Kontingentplatz und eine neue Quarantäne. Die ID steht in der Quarantäne-Benachrichtigung und in der OWA-Geräteliste. |
| **Mailbox address** | Nur nötig, wenn der Anmeldename keine Adresse ist. |

### Geräteprofile vergleichen (nur bei Problemen)

Unter *Server diagnostics* liegt **Compare device profiles**. Der Knopf schickt pro Profil einen minimalen FolderSync mit derselben DeviceId und zeigt, welche Fingerabdrücke der Server akzeptiert.

> Auch hier gilt: Exchange kann pro akzeptiertem `DeviceType` eine Partnerschaft anlegen. Bei knappem Kontingent **erst in OWA aufräumen**, dann probieren. Der Knopf fragt vorher nach.

Ergebnis-Interpretation:

| Ausgabe | Bedeutung |
|---|---|
| „accepted" | Dieses Profil geht → auswählen |
| „accepted (provisioning required)" | Auch gut, das erledigt das Add-on selbst |
| „rejected — ABQ rule or device quota" | HTTP 403 |
| „credentials rejected" | HTTP 401 — Kennwort oder Anmeldename falsch |

Wenn **kein einziges** Profil akzeptiert wird, liegt es nicht am Fingerabdruck, sondern an den Zugangsdaten oder am erschöpften Gerätekontingent.

### Testen und anlegen

1. **Test Connection** — prüft Erreichbarkeit, Zugangsdaten und Protokollversion. Erfolg sieht so aus:
   `Connected. Protocol 14.0 as WindowsOutlook15.`
2. **Add Account** — legt das Konto an, der Erstabgleich läuft im Hintergrund los.

---

## Schritt 5 — Was danach passiert

Etwa sechs Sekunden nach dem Anlegen startet der erste Abgleich. In dieser Reihenfolge:

1. Protokollversion aushandeln (`OPTIONS`)
2. Gerätedaten melden (`Settings`) — beim Outlook-Profil übersprungen, weil echtes Outlook das auch nicht sendet
3. Bei Bedarf Provisioning (zweistufig, Policy-Key holen)
4. Ordnerstruktur holen (`FolderSync`)
5. Pro Ordner die Nachrichten (`Sync`)

**Der erste Abgleich pro Ordner braucht zwei Runden.** Ein `Sync` mit `SyncKey=0` liefert per Protokolldefinition nur den neuen Schlüssel und **keine** Nachrichten; die Daten kommen erst mit der zweiten Anfrage. Das Add-on macht das automatisch — aber wenn Du zusiehst, wirkt der erste Moment leer.

Fertiges Ergebnis:

```
Privileged-Build                    Standard-Build

vorname@firma.org                   Lokale Ordner
├── Posteingang                     └── vorname@firma.org
├── Gesendete Elemente                  ├── Posteingang
├── Entwürfe                            ├── Gesendete Elemente
├── Gelöschte Elemente                  └── …
└── (eigene Ordner…)
```

Beim Privileged-Build tragen Posteingang, Gesendet, Entwürfe und Papierkorb echte Thunderbird-Ordnerkennzeichen — richtige Symbole, Löschen wandert in den Papierkorb, Gesendetes wird dort abgelegt.

**Mails schreiben:** Ganz normal über *Verfassen*. Das Add-on fängt den Versand ab und schickt die Nachricht über EAS `SendMail` statt SMTP. Ein SMTP-Server muss nicht konfiguriert sein.

---

## Verschieben und Löschen

Beides wird auf den Server gespiegelt, und zwar über dasselbe EAS-Kommando.

**Löschen ist Verschieben.** Thunderbirds Löschen legt die Nachricht in den
Papierkorb — für Exchange ist das ein Verschieben nach *Gelöschte Elemente*, also
genau dasselbe. Endgültiges Löschen (Umschalt+Entf) wird als echtes Löschen
weitergereicht.

**Verschieben zwischen EAS-Ordnern** landet ebenfalls auf dem Server.

**Verschieben aus dem Konto heraus** — etwa in *Lokale Ordner* — wird bewusst
**nicht** gespiegelt. Ob das ein Löschen sein soll, ist nicht erkennbar, und die
falsche Annahme wäre nicht rückgängig zu machen. Die Serverkopie bleibt also
liegen; wer sie loswerden will, löscht sie in OWA.

Für Nachrichten, die vor der Einrichtung des Add-ons schon lokal lagen, gibt es
keine Zuordnung zur Serverkopie. Sie lassen sich lokal löschen, aber nicht über
das Add-on auf dem Server.

---

## Übrig gebliebene Kontoknoten

Thunderbird bietet für Konten dieser Bauart kein *Löschen* an. Bleibt nach einer
abgebrochenen Einrichtung — oder nach einer Neuinstallation des Add-ons, die den
Add-on-Speicher leert, während der Knoten im Mail-Profil überlebt — ein Eintrag
im Ordnerbaum stehen, kommst Du über Thunderbird nicht mehr an ihn heran.

Die Einrichtungsseite zeigt solche Knoten unter **Leftover account nodes**:

| Knopf | Wirkung |
|---|---|
| **Restore** | Holt das Konto samt **originaler DeviceId** zurück. Der Server sieht dasselbe Gerät wie zuvor — keine neue Partnerschaft, keine neue Quarantäne. Nur verfügbar, wenn der Knoten eine brauchbare Kopie der Konfiguration trägt. |
| **Delete node** | Entfernt den Knoten **samt der darin gespeicherten Mails**. |

Trägt ein alter Knoten keine Kopie, hilft der Umweg über *Advanced → Device ID*:
Knoten löschen, Konto neu anlegen und dabei die alte Geräte-ID eintragen.

---

## Schritt 6 — Statusanzeige lesen

Über die Symbolleisten-Schaltfläche **EAS Sync** — falls noch nicht sichtbar, erst wie in Schritt 4 beschrieben in die Symbolleiste ziehen:

| Punkt | Text | Bedeutung |
|---|---|---|
| 🟢 | OK | Letzter Abgleich erfolgreich |
| 🟡 | Syncing… | Läuft gerade |
| 🟠 | Blocked | Server weist das Gerät ab oder drosselt — mit Restwartezeit |
| 🔴 | Error | Fehler; Mauszeiger über die Zeile halten für den Text |
| ⚫ | Never synced | Noch nichts gelaufen |

Steht „push" in der Zeile, hält das Add-on eine Ping-Verbindung offen und bekommt Änderungen sofort.

**Sync All** stößt sofort einen Abgleich an **und hebt eine laufende Wartesperre auf** — genau das, was Du nach einer Gerätefreigabe in OWA drücken willst.

---

## Schritt 7 — Quarantäne und Sperren

### Der Normalfall: Quarantäne

Viele Exchange-Organisationen stellen **jedes** neue Gerät zunächst in Quarantäne. Das ist keine
Fehlfunktion und hat nichts mit dem Fingerabdruck zu tun.

Erkennbar daran, dass die Einrichtung sichtbar **funktioniert**: Der Konto-Knoten entsteht, der
komplette Ordnerbaum wird angelegt — und im Posteingang liegt genau **eine** Nachricht von
„Microsoft Outlook" mit dem Betreff *„Die Synchronisierung mit Exchange ActiveSync ist auf Ihrem
Gerät vorübergehend blockiert…"*. Genau so verhält sich Exchange bei Quarantäne: Anmeldung und
Ordnerstruktur ja, Inhalte nein.

Diese Nachricht ist die beste Diagnose, die man bekommen kann. Sie listet auf, was tatsächlich auf
der Leitung ankam:

```
Gerätemodell:                    WindowsOutlook15
Gerätetyp:                       WindowsOutlook15
Geräte-ID:                       3F7A1C9E4B2D48A6B0E5C81D6F03A2B7
Gerätebetriebssystem:
Gerätebenutzer-Agent:            Outlook/16.0 (16.0.17932.20884; C2R; x64)
Exchange ActiveSync-Version:     14.0
Gerätezugriffsstatus:            Quarantined
Grund für Gerätezugriffsstatus:  Global
```

Die letzte Zeile ist die wichtigste:

| Grund | Bedeutung | Konsequenz |
|---|---|---|
| **Global** | Organisationsweite Standardrichtlinie stellt jedes neue Gerät in Quarantäne | Nur der Administrator kann freigeben. Ein anderes Geräteprofil ändert nichts. |
| **Individual** | Regel auf genau dieses Postfach oder Gerät | Administrator, oder anderes Geräteprofil probieren |
| **DeviceRule** | Allow/Block/Quarantine-Regel auf DeviceType oder User-Agent | Geräteprofil wechseln kann helfen — siehe *Compare device profiles* |

**Freigabe anfordern.** Der Administrator braucht nur drei Angaben, alle aus der Nachricht oben
(die Geräte-ID steht auch in der Einrichtungsseite bei jedem Konto):

```
Postfach:   vorname@firma.org
Geräte-ID:  <32 Hex-Zeichen>
Gerätetyp:  WindowsOutlook15
```

Freigegeben wird im Exchange Admin Center unter *Mobil → Mobilgeräte-Zugriff → Quarantänegeräte*,
oder per PowerShell mit `Set-CASMailbox … -ActiveSyncAllowedDeviceIDs @{Add="…"}`.

> Wenn Du ein fremdes Geräteprofil verwendest, steht in der Geräteliste des Administrators
> „WindowsOutlook15", obwohl dort Thunderbird sitzt. Für den Zugang zum eigenen Postfach ist das
> unkritisch — aber wenn Du ohnehin mit ihm sprichst, sag dazu, was das Gerät wirklich ist.

Nach der Freigabe im Popup **Sync All** drücken. Das hebt eine laufende Wartesperre sofort auf.

### Der Problemfall: Abweisung

Symptom: oranges **Blocked**, HTTP 403 oder EAS-Status 126/129/177 — und **kein** Ordnerbaum.

Zwei Ursachen, beide am selben Ort zu beheben:

1. **Sperrliste (ABQ)** — der DeviceType steht nicht auf der Erlaubnisliste
2. **Gerätekontingent voll** — Exchange erlaubt nur eine begrenzte Zahl Partnerschaften pro
   Postfach, meist fünf. Jedes alte Handy und jeder frühere Testlauf zählt mit. Dies ist die
   häufigere Ursache und wird regelmäßig für eine ABQ-Regel gehalten.

**Vorgehen:**

1. In OWA anmelden (`https://mail.<deine-domain>`)
2. **Optionen → Telefon → Mobilgeräte**
3. Alte, nicht mehr genutzte Geräte **löschen** — zuerst das, bevor man am Profil dreht
4. Erneut **Test Connection**. Kommt jetzt eine Verbindung zustande, war es das Kontingent.
5. Weiterhin 403 → **Compare device profiles** zeigt, ob ein anderer Fingerabdruck durchkommt

Nach einer Ablehnung bleibt das Add-on **30 Minuten still**. Das ist Absicht: Exchange schickt Dir für *jeden* Provision-Versuch eine neue Quarantäne-Benachrichtigung per Mail. Ohne diese Pause wären das alle fünf Minuten eine.

---

## Schritt 8 — Aktualisieren

Neue `.xpi` **über** die vorhandene Erweiterung installieren. Nicht vorher entfernen.

| Weg | Folge |
|---|---|
| ✅ Add-on aus Datei installieren → neue `.xpi` | Gleiche Add-on-ID, Aktualisierung an Ort und Stelle, alle Daten bleiben |
| ❌ Erweiterung entfernen → neu installieren | Speicher gelöscht, **neue DeviceId** — Exchange sieht ein fremdes Gerät, Quarantäne beginnt von vorn, ein weiterer Kontingentplatz verbraucht |

Die DeviceId ist der wichtigste Zustand des Clients. Sie wird einmal erzeugt und nie wieder verändert. (Outlook selbst hatte hier einen Fehler: Builds 16.0.14701–14827 haben sie bei jedem Start neu erzeugt, mit genau den beschriebenen Folgen.)

Zwischen Standard- und Privileged-Build kann man in beide Richtungen wechseln — gleiche Add-on-ID, die Kontodaten bleiben erhalten, nur die Ordnerstrategie ändert sich.

---

## Fehlersuche

Fehlerkonsole öffnen mit **Strg+Umschalt+J**, nach `[EAS]` filtern.

| Symptom | Ursache und Behebung |
|---|---|
| Einrichtungsseite öffnet sich nicht | Privileged-Build ohne `extensions.experiments.enabled=true` installiert → Einstellung setzen, neu installieren |
| „Standard build" trotz Privileged-`.xpi` | Dieselbe Ursache |
| *Test Connection* → HTTP 404 | Falscher Hostname, oder ein Pfad/Port im Feld gelandet |
| *Test Connection* → HTTP 401 | Anmeldename oder Kennwort falsch. Bei Umlauten im Kennwort: *Credential encoding* auf ISO-8859-1 |
| *Test Connection* → HTTP 403 | Siehe Schritt 7 |
| Verbindung klappt, aber keine Mails | Fehlerkonsole ansehen. Meldet der Start eine Codepage-Inkonsistenz, ist das die Ursache → `node tools/selftest.mjs` |
| Ordner da, aber leer | Beim allerersten Durchlauf normal (Priming). Spätestens der zweite Zyklus füllt sie. |
| Konto lässt sich nicht entfernen | Beim Entfernen wird auch der Thunderbird-Kontoknoten gelöscht; die Gerätepartnerschaft auf dem Server bleibt und muss in OWA weg |

### Status-Codes im Protokoll

| Code | Bedeutung | Wird behandelt? |
|---|---|---|
| 142 / 143 / 144 / 145 | Provisioning nötig oder Policy-Key veraltet | Ja, automatisch |
| 3 / 9 / 12 / 131 | Sync-Schlüssel ungültig | Ja, Ordner wird neu aufgebaut |
| 126 / 129 / 177 | ActiveSync für das Postfach deaktiviert, Gerät gesperrt, oder Gerätekontingent voll | 30 Minuten Pause, Admin-Aktion nötig |
| 165 | `DeviceInformationRequired` — **keine** Sperre | Ja, die Gerätedaten gehen in die Provision-Anfrage |
| HTTP 503 | Drosselung | Wartet die vom Server genannte Zeit ab |

---

## Was das Add-on nicht kann

- **Nur E-Mail.** Kalender, Kontakte, Aufgaben und Notizen werden nicht abgeglichen.
- **Nur Basic-Authentifizierung**, also kein Exchange Online (das verlangt seit 2026 Protokoll 16.1 mit OAuth 2.0).
- **Höchstens Protokoll 14.1.** 16.x hat Kalender-, Serientermin- und Entwurfsbehandlung geändert.
- **Kein „Abrufen"-Knopf.** Thunderbird hat kein EAS-Backend; der Kontoknoten ist technisch ein lokaler Speicher, den das Add-on befüllt. Der Abgleich läuft über Push und das eingestellte Intervall, nicht über Thunderbirds Abrufen-Schaltfläche.
- **Nicht signiert**, daher auch nicht über addons.thunderbird.net verteilbar — der Privileged-Build wäre dort ohnehin nicht zulässig.
