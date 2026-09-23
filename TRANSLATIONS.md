# Translations

`src/utils/linkedinPhrases.ts` is the source of truth for LinkedIn phrases and for the extension's own copy. `linkedinPhrases.csv` in the project root is generated from that file for Google Sheets.

```bash
npm run export:csv
```

Run that command after any change to `linkedinPhrases.ts`. The next export rebuilds the whole sheet, so a column added only in Google Sheets is replaced.

## Adding a language

1. Add its code to `LOCALES` in `src/utils/linkedinPhrases.ts` (for example `'de'`).
2. Add the same argument to the `phrases()` and `ui()` helpers. The project fails to compile until every entry has that slot.
3. Fill the new slot. An empty lookup list skips that language when matching LinkedIn text. An empty UI string falls back to English, then French.
4. Run `npm run export:csv`. The new language appears as its own column. The export script does not need a change.

The popup language control currently offers English and French. A new language also needs a button there before users can select it.
