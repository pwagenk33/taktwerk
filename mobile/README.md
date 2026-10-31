# TrackInsight als App (App Store und Play Store)

Eine dünne Capacitor-Hülle um die Web-App. Beim ersten Start fragt sie nach der Firmenadresse (z. B. `muster.trackinsight.ch`), merkt sie sich und öffnet danach direkt die normale App dieser Firma. Alle Funktionen (Zeiterfassung, Stempeln, Belege fotografieren, Offline) kommen aus der Web-App; ein Update auf dem Server ist sofort in der App, ohne neue Store-Version.

Dieser Ordner gehört nicht zu den npm-Workspaces, damit Docker und CI nichts davon installieren.

## Was nur du machen kannst

| Schritt | Kosten | Wo |
|---|---|---|
| Apple Developer Program (Firma oder Einzelperson) | 99 USD pro Jahr | developer.apple.com/programs |
| Google Play Console | 25 USD einmalig | play.google.com/console |
| iOS bauen: braucht einen Mac mit Xcode **oder** einen Build-Dienst (z. B. Codemagic, Ionic Appflow) | Mac oder Dienst | |
| Android bauen: Android Studio, läuft auch unter Windows | gratis | developer.android.com/studio |
| Datenschutzerklärung als öffentliche Seite (Pflicht in beiden Stores) | | z. B. `/datenschutz` auf der Website |
| Screenshots (Handy 6,7" und 5,5" für Apple, Handy für Google) | | aus dem Demo-Konto |

Texte für die Store-Einträge in Deutsch, Französisch, Englisch und Italienisch: [store/listing.md](store/listing.md).

## Bauen

```bash
cd mobile
npm install
npx cap add android      # einmalig, legt android/ an
npx cap add ios          # einmalig, nur auf dem Mac
npx cap sync
npx cap open android     # öffnet Android Studio: Build → Generate Signed Bundle
npx cap open ios         # öffnet Xcode: Product → Archive
```

Icons und Splash-Screen: `npx @capacitor/assets generate` mit einem 1024×1024-Logo in `assets/icon.png`.

## NFC-Aufkleber und Mail-Links öffnen die App

Damit ein Stempel-Aufkleber (`…/#stempeln/<token>`) die installierte App statt den Browser öffnet, braucht es «Universal Links» (iOS) und «App Links» (Android):

1. Auf dem Server in `.env` setzen:
   - `APP_IOS_TEAM_ID=` die Team-ID aus dem Apple-Developer-Konto (10 Zeichen)
   - `APP_ANDROID_SHA256=` den SHA-256-Fingerabdruck aus Play Console → App-Integrität → App-Signatur
   Der Server liefert dann `/.well-known/apple-app-site-association` und `/.well-known/assetlinks.json`.
2. iOS: in Xcode unter Signing & Capabilities «Associated Domains» mit `applinks:app.trackinsight.ch` (und `applinks:*.trackinsight.ch` für Firmen-Subdomains) ergänzen.
3. Android: in `android/app/src/main/AndroidManifest.xml` einen Intent-Filter mit `android:autoVerify="true"` für `https://app.trackinsight.ch` und `https://*.trackinsight.ch` ergänzen.

Die Web-App reagiert in der App auf solche Links selbst (`appUrlOpen` in `web/src/main.tsx`).

## Ehrlich: was noch nicht geprüft ist

- Die Hülle wurde nicht auf einem echten Gerät und nicht im Store-Review getestet.
- Apple lehnt reine «Website in einer Hülle»-Apps manchmal ab (Richtlinie 4.2). Für das Review hilft: Demo-Zugang für die Prüfer angeben, Stempeln per NFC und Beleg-Foto in der Beschreibung zeigen. Falls Apple ablehnt, sind native Push-Mitteilungen der nächste Schritt.
- Web-NFC zum *Beschreiben* von Aufklebern gibt es nur in Chrome auf Android; das *Lesen* (Hinhalten zum Stempeln) klappt auf iPhone und Android ohne App.
