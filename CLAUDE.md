# Preen

Lokale macOS-App, Bilder werden web-fertig als WebP ausgegeben.
Tauri v2, Rust-Backend, React/TypeScript/Tailwind, Bun.

## Design
design/panel-reference.html ist verbindlich: Farben, Maße, Radien,
Abstände, Schriftgrößen, Zeiten und Kurven. Nicht aus Screenshots raten.
Akzentflächen #2e6d63, Feder #50988d.

## Bildgrößen
Ein Preset ist lange Kante, Pixeldeckel und Größengrenze. Die lange
Kante allein reicht nicht: bei 2400 landet ein Hochformat auf
2400x3200, also 7,7 MP gegen 3,2 MP eines 16:9-Heros, und keine
Qualitätsstufe holt diese Datei zurück unter die Grenze.
Reicht der Qualitätsboden nicht, nimmt die Notfallskalierung dreimal
10 % von der langen Kante, aber nie unter die Untergrenze: ein
1182-px-"Hero" wäre kleiner als ein Inhaltsbild. Danach ehrlich zu
groß ausgeben und limitMissed setzen, nicht still zu klein.
0,39 B/px bei Q60 sind für dichte Naturmotive korrekt, gegen
cwebp -q 60 auf identischen Pixeln geprüft (acht Bilder, byte-gleich).
Wer diese Zahl sieht, sucht keinen Fehler im Encoder, sondern
verkleinert.

## Panelgeometrie
Feste Höhe je Zustand, an einer Stelle definiert. Keine dynamische
Höhenmessung, kein ResizeObserver.
Ruhe 184, ein Bild 381, mehrere Bilder 403, fertig 258, fertig mit
zwei oder mehr Fehlschlägen 274. Neben das 60 px hohe Vorschaubild
passen drei Textzeilen ohne Wachstum, die vierte kostet 16. Die Zahl
kommt aus der Zusicherung im Debug-Build, nicht aus dem Stylesheet
nachgerechnet — 2 px danebengelegen.
Der Drop-Zustand ändert die Höhe nicht, er liegt als Overlay darüber.
Abgelehnte Dateien brauchen auch keine: im Ladezustand ersetzen sie die
Einstellungszeile, in der Ruhe die Zeile "Bild hierher ziehen".
Fehlertexte kurz halten, sie stehen im Panel hinter dem Dateinamen in
rund 42 Zeichen; kurz und ganz zu lesen schlägt vollständig und
abgeschnitten.
overflow: hidden auf html, body und #root; dazu preventScroll beim
Fokus. Beides muss bleiben, sonst scrollt der Webview die Kopfzeile raus.
Für Geometrie offsetHeight benutzen, nie getBoundingClientRect, das
misst laufende Transforms mit (scale(0.96) ergab 15 px zu wenig).
Fenstergröße nur über frame::set_size setzen, nie in Schleifen aus
einem Thread; der Webview hinkt sonst nach und es entsteht ein grauer
Streifen.
Im Debug-Build prüft eine Zusicherung die natürliche Inhaltshöhe gegen
den Sollwert. Nach jeder Layoutänderung einmal im Debug-Build durch
alle Zustände schalten, F8 schaltet den Drop-Zustand um.
Die Zusicherung misst verzögert und schweigt, wenn der Zustand
inzwischen ein anderer ist — sonst meldet sie bei schnellen Läufen
Unsinn und man liest sie weg.

## macOS und Tauri, bekannte Fallen
AppKit nur im Hauptthread. Shortcut, Tray und Zweitstart müssen
panel::show über run_on_main_thread aufrufen, sonst Absturz.
core:default erlaubt keine Fensteränderungen wie hide oder
start_dragging: entweder Berechtigung eintragen oder einen eigenen
Rust-Befehl nehmen. data-tauri-drag-region zieht nur bei direktem
Treffer, also "deep" oder eine eigene Ebene.
tauri build --debug baut das Frontend trotzdem produktiv. Debug-Code
über TAURI_ENV_DEBUG bzw. __PREEN_DEBUG__ schalten.
JS- und Rust-Version eines Plugins müssen zusammenpassen, sonst
bricht der Build ab.

## Tailwind
Eigene Utilities verlieren gegen die Klassenreihenfolge, Panel-Zustände
stehen deshalb als Inline-Stil. Klassennamen nicht so wählen, dass sie
mit Tailwind kollidieren (text-field kollidierte mit text-{farbe} und
ergab weiß auf weiß).

## Arbeitsweise
Erst messen, dann ändern. Eigene Logs sind kein Beweis, wenn es ums
Aussehen geht: screencapture -x machen und im Bild nachsehen.
Du kannst die App nicht bedienen: keine Finder-Drags, keine Klicks
(System Events −25208). Einzelne Fenster abfotografieren geht nicht,
Vollbild schon. Tastendrücke gehen über osascript key code. Bilder
kommen per open -n -a Preen.app --args <bild> hinein, Enter startet
die Verarbeitung.
Was ohne GUI prüfbar ist, über preen-cli prüfen; es ruft dieselbe
Funktion wie der Tauri-Befehl auf (pipeline::convert):
  cargo run --features cli --bin preen-cli -- \
    --preset hero --name testbild --out /tmp/preen-test bild1.jpg
Presets: inhaltsbild (lange Kante 1600, 1,8 MP, 260 KB, Notfall-
Untergrenze 1000), hero (2400, 3,5 MP, 500 KB, Untergrenze 1600).
--json gibt dasselbe maschinenlesbar aus, Exitcode 1 sobald eine
Datei fehlschlägt.
--features cli muss sein: ohne das Feature baut cargo das zweite
Binary nicht, und genau das ist der Punkt. Mit zwei Binaries benennt
der Tauri-Bundler preen-cli in preen um und packt das Werkzeug statt
der App ins .app-Bundle.
Wenn etwas wirklich einen Klick braucht, anhalten und genau sagen, was
zu tun ist, statt in einer Schleife weiterzuversuchen.
Erst testen, dann committen, und am Ende jedes Schrittes committen,
nicht erst am Ende der Etappe. Nicht von selbst committen.
Autor: LieferEule <206203779+LieferEule@users.noreply.github.com>
