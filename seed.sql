-- Dati iniziali: catalogo preso dal sito officinedeicedri.it.
-- ATTENZIONE: i prezzi sono quelli al pubblico scorporati dell'IVA, da sostituire con il listino Ho.Re.Ca.

INSERT INTO zones (name, delivery_days, cutoff_time, lead_days, delivery_fee, free_over, sort) VALUES
 ('Riviera dei Cedri', '1,2,3,4,5', '17:00', 1, 0, 0, 1),
 ('Cosenza e provincia', '2,4', '12:00', 1, 1000, 15000, 2),
 ('Spedizione corriere (Italia)', '1,3,5', '12:00', 2, 1500, 30000, 3);

INSERT INTO categories (name, sort) VALUES
 ('Liquori e distillati', 1),
 ('Confetture e mostarde', 2),
 ('Fichi', 3),
 ('Cedro candito e dolci', 4),
 ('Confezioni regalo', 5);

INSERT INTO products (sku, name, description, category_id, unit, pack, price, vat_rate, min_qty, step_qty, sort, featured) VALUES
 ('LIQ-CED-50', 'Cedro · Liquore di cedro', 'Liquore di cedro di Santa Maria del Cedro, 28% vol.', 1, 'bottiglia', '50 cl', 1385, 22, 1, 1, 1, 1),
 ('LIQ-CED-70', 'Cedro · Liquore di cedro', 'Liquore di cedro di Santa Maria del Cedro, 28% vol.', 1, 'bottiglia', '70 cl', 1631, 22, 1, 1, 2, 0),
 ('LIQ-CED-70-6', 'Cedro · Liquore di cedro', 'Cartone da 6 bottiglie, formato bar.', 1, 'cartone', '6 × 70 cl', 9300, 22, 1, 1, 3, 1),
 ('AMA-CED-50', 'Cedramaro · Amaro di cedro', 'Amaro di cedro con erbe del territorio, 28% vol.', 1, 'bottiglia', '50 cl', 1385, 22, 1, 1, 4, 0),
 ('AMA-CED-70', 'Cedramaro · Amaro di cedro', 'Amaro di cedro con erbe del territorio, 28% vol.', 1, 'bottiglia', '70 cl', 1631, 22, 1, 1, 5, 1),
 ('AMA-CED-70-6', 'Cedramaro · Amaro di cedro', 'Cartone da 6 bottiglie, formato bar.', 1, 'cartone', '6 × 70 cl', 9300, 22, 1, 1, 6, 0),
 ('CON-DIA-250', 'Diamante Nero', 'Mostarda di fichi con mosto cotto.', 2, 'vasetto', '250 g', 809, 10, 1, 1, 1, 0),
 ('CON-CED-250', 'Cedrina', 'Confettura di cedro.', 2, 'vasetto', '250 g', 627, 10, 1, 1, 2, 1),
 ('CON-NET-250', 'Nettarina', NULL, 2, 'vasetto', '250 g', 681, 10, 1, 1, 3, 0),
 ('FIC-FRH-250', 'Frhumieli', 'Fichi secchi al miele di castagno e rum.', 3, 'vasetto', '250 g', 809, 10, 1, 1, 1, 0),
 ('FIC-MBR-250', '''Mbriane', 'Fichi secchi al forno nel caramello di mosto.', 3, 'confezione', '250 g', 809, 10, 1, 1, 2, 0),
 ('FIC-CRO-250', 'Crocette di fichi farciti', NULL, 3, 'confezione', '250 g', 900, 10, 1, 1, 3, 0),
 ('FIC-BOT-250', 'Bottoncini', 'Fichi ricoperti di cioccolato.', 3, 'confezione', '250 g', 900, 10, 1, 1, 4, 0),
 ('DOL-CAN-300', 'Cedro candito', 'Cedro candito in coppa.', 4, 'coppa', '300 g', 727, 10, 1, 1, 1, 1),
 ('DOL-CAN-1KG', 'Cedro candito a cubetti', 'Formato pasticceria.', 4, 'kg', 'sfuso', 2200, 10, 1, 0.5, 2, 0),
 ('DOL-CCI-250', 'Cedro candito al cioccolato', NULL, 4, 'confezione', '250 g', 900, 10, 1, 1, 3, 0),
 ('DOL-PAN-60', 'Panicelli', 'Fagottini di uva passa e cedro cotti al forno.', 4, 'pz', '50/60 g', 445, 10, 1, 1, 4, 0),
 ('DOL-PAP', 'Papillons', NULL, 4, 'pz', NULL, 445, 10, 1, 1, 5, 0),
 ('REG-NAT', 'Confezione regalo Natale', 'Cedramaro 50 cl, Liquore al cedro 50 cl, Diamante Nero, Nettarina, Cedrina.', 5, 'confezione', NULL, 4090, 22, 1, 1, 1, 0);
