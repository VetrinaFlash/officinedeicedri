# Gestionale ordini Ho.Re.Ca. — Officine dei Cedri

App per i clienti (bar, ristoranti, pasticcerie) + pannello del fornitore.
Tutto su Cloudflare: Pages (sito + API), D1 (database), R2 (foto prodotti). Nessuna libreria esterna, niente build.

- **Clienti** → `https://ordini.officinedeicedri.it/`
- **Agente** (stesso pannello, vede solo i suoi clienti)
- Panoramica con ordini, imponibile e provvigioni del mese, clienti da risentire, offerte in corso
- Ordini dei suoi clienti (sola lettura sullo stato), inserimento ordini per loro, messaggi ai clienti
- Nuovi clienti acquisiti: il fornitore riceve un avviso e decide sconto e condizioni
- Le sue provvigioni per periodo, notifiche push quando un suo cliente ordina

**Fornitore** → `https://ordini.officinedeicedri.it/admin/`

## Il dominio: il sito WordPress resta com'è

Non bisogna copiare l'index né toccare WordPress. Il gestionale vive su un **sottodominio**:

```
officinedeicedri.it          → WordPress (hosting attuale, invariato)
ordini.officinedeicedri.it   → Cloudflare Pages (questo progetto)
```

1. Pubblica il progetto su Pages (vedi sotto): ottieni `odc-gestionale.pages.dev`.
2. Pages → progetto → **Custom domains** → aggiungi `ordini.officinedeicedri.it`.
3. Nel pannello DNS **attuale** del dominio (dove sta oggi, non serve spostarlo su Cloudflare) aggiungi:
   `CNAME  ordini  →  odc-gestionale.pages.dev`
4. Cloudflare attiva da solo il certificato HTTPS.
5. In WordPress il footer ha già il link **"Area riservata"**: puntalo a `https://ordini.officinedeicedri.it/`.
   Se vuoi, aggiungi anche una voce "Ordini Ho.Re.Ca." nel menu.

Così il cliente vede il sito di sempre e, dall'Area riservata, entra nel gestionale con lo stesso logo e i colori del marchio.

## Messa online (una volta sola)

Il deploy parte da GitHub: ogni push su `main` pubblica il sito. Il database si crea e si popola da solo alla prima visita.

1. **D1**: Cloudflare → Storage & Databases → D1 → *Create* → nome `odc-gestionale`. Copia l'ID in `wrangler.toml` (`database_id`) e fai push.
2. **R2**: R2 → *Create bucket* → nome `odc-gestionale-images`.
3. **Pages**: Workers & Pages → *Create* → Pages → *Connect to Git* → scegli il repository.
   Build command: vuoto · Build output directory: `public` · Root directory: vuota.
4. **Secret** (Pages → progetto → Settings → Variables and Secrets, tipo *Secret*):
   - `VAPID_PRIVATE_KEY` → notifiche push (valore fornito a parte)
   - `RESEND_API_KEY` → email (facoltativo)
   - `CRON_SECRET` → promemoria (facoltativo)
   Dopo aver aggiunto i secret: Deployments → *Retry deployment*.
5. **Dominio**: Pages → Custom domains → `ordini.officinedeicedri.it`, poi nel DNS del dominio
   `CNAME  ordini  →  <progetto>.pages.dev`.

### Promemoria automatici (facoltativo)

Pages non ha i cron, quindi c'è un micro‑worker che ogni 30 minuti chiama il gestionale:

```bash
cd cron-worker
npx wrangler secret put CRON_SECRET   # lo stesso valore impostato su Pages
npx wrangler deploy
```

Il cliente riceve "Ordina entro le 17:00 per ricevere mercoledì" X ore prima del limite (X si imposta nel pannello, 0 = spento). Solo clienti con notifiche attive e almeno un ordine negli ultimi 90 giorni; mai due volte per la stessa consegna e mai se hanno già ordinato.

### Email (Resend)

Con `RESEND_API_KEY` partono: nuovo ordine al fornitore, conferma al cliente, inviti e reset password.
Su Resend aggiungi il dominio `officinedeicedri.it`: i record da inserire nel DNS (TXT e MX su `send`, TXT su `resend._domainkey`) non toccano la posta che il fornitore usa già.
Senza Resend tutto funziona lo stesso: gli inviti si mandano col pulsante WhatsApp.

## Sviluppo in locale

```bash
cp .dev.vars.example .dev.vars   # e compila i valori
npm install
npm run dev                      # il database locale si crea da solo                      # http://localhost:8788
```

## Cosa fa

**Cliente (PWA installabile)**
- Catalogo con i suoi prezzi (sconto % o prezzo fisso per prodotto), ricerca, categorie, preferiti, "I soliti"
- Data di consegna secondo la sua zona, con limite orario e conto alla rovescia
- Carrello con IVA per aliquota, spese di consegna e soglia di gratuità, ordine minimo
- Storico ordini, stato in tempo reale, "Ordina di nuovo", annullamento finché non è confermato
- Notifiche push (conferma, preparazione, consegna, modifiche, messaggi, promozioni)

**Agente** (stesso pannello, vede solo i suoi clienti)
- Panoramica con ordini, imponibile e provvigioni del mese, clienti da risentire, offerte in corso
- Ordini dei suoi clienti (sola lettura sullo stato), inserimento ordini per loro, messaggi ai clienti
- Nuovi clienti acquisiti: il fornitore riceve un avviso e decide sconto e condizioni
- Le sue provvigioni per periodo, notifiche push quando un suo cliente ordina

**Fornitore**
- Panoramica: da confermare, consegne oggi/domani, imponibile del mese, grafico 30 giorni, prodotti e clienti top, clienti da richiamare, scorte basse
- Ordini: filtri, ricerca, cambio stato singolo o in blocco, modifica righe (peso reale, sostituzioni, prezzi), cambio data, note interne, pagato, rif. fattura/DDT, messaggio al cliente, stampa, WhatsApp
- Inserimento ordini presi al telefono/WhatsApp/agente
- Preparazione: totali da preparare per giorno + giro consegne per zona con checklist e firma, stampabile
- Prodotti: foto (R2 o URL), giacenze, minimi e multipli (es. kg a 0,5), in evidenza, prodotti riservati a certi clienti, import/export listino CSV
- Clienti: anagrafica e fatturazione (SDI/PEC), zona, sconto, listino personalizzato, pagamento, blocco con messaggio, più accessi per locale, invito via email o WhatsApp
- Zone: giorni del giro, anticipo, orario limite, costo e soglia consegna gratuita
- Agenti: accesso proprio, clienti assegnati, provvigione %, notifica a fornitore e agente a ogni ordine dei suoi clienti
- Provvigioni: report per periodo e per agente (fissate sull'ordine al momento dell'ordine), export CSV
- Promozioni: sconto % o prezzo speciale su un prodotto, con date, per tutti o per zona; badge "Offerta" nel catalogo, push ai clienti, quantità vendute in promo
- Comunicazioni mirate: a tutti, a una zona, ai clienti di un agente o a un singolo cliente, con push
- Impostazioni: sospensione ordini (ferie), giorni di chiusura, ordine minimo, conferma automatica, promemoria
- Esportazione ordini CSV per il commercialista

## Note tecniche

- Importi in centesimi, IVA esclusa sul listino; IVA calcolata per aliquota.
- Pannello protetto da `ADMIN_PASSWORD` (confronto a tempo costante, blocco dopo 8 errori in 15 minuti). Password clienti PBKDF2, sessione in cookie HttpOnly, blocco dopo 8 tentativi falliti in 15 minuti, controllo dell'origine sulle richieste che modificano dati.
- Web Push implementato con WebCrypto (VAPID + aes128gcm), nessuna dipendenza. Su iPhone le notifiche funzionano con l'app aggiunta alla Home (iOS 16.4+): l'app lo spiega al cliente.
