-- The default main colour changed from Swiss red to violet (design direction «Bunt mit System»).
-- Companies that still have the old default get the new one; chosen colours stay.
UPDATE `organizations` SET `settings` = JSON_SET(`settings`, '$.branding.primaryColor', '#6D4CF0') WHERE UPPER(JSON_UNQUOTE(JSON_EXTRACT(`settings`, '$.branding.primaryColor'))) = '#D52B1E';
