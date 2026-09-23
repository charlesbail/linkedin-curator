/**
 * LinkedIn phrases the extension searches for, and copy the extension shows.
 *
 * Lookups are tried in every language that has a phrase. Visible copy uses
 * one language: the stored popup choice, otherwise the browser language,
 * otherwise English.
 *
 * Add a language by extending `LOCALES`, then filling the new slot on every
 * entry (the helper's return type fails the build until you do). An empty
 * lookup list means that language is not matched yet. An empty UI string
 * falls back to English, then French.
 *
 * `{name}` is the person LinkedIn prints in that label.
 */

export const LOCALES = ['fr', 'en'] as const;
export type Locale = (typeof LOCALES)[number];

export type MatchMode = 'exact' | 'prefix' | 'contains';

export interface PhraseLookup {
  match: MatchMode;
  phrases: Record<Locale, readonly string[]>;
}

/** Plain data passed into the profile-tab block script. Regexes are not serializable. */
export interface BlockAutomationPhrases {
  plusLabels: string[];
  blockMenuPrefixes: string[];
  blockConfirmLabels: string[];
}

function phrases(fr: readonly string[], en: readonly string[]): Record<Locale, readonly string[]> {
  return { fr, en };
}

function ui(fr: string, en: string): Record<Locale, string> {
  return { fr, en };
}

function collapseWhitespace(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function flexibleWhitespace(escaped: string): string {
  return escaped.replace(/ +/g, '\\s+');
}

/** Whole-label match. `{name}` becomes a capture group. */
function phraseToRegExp(phrase: string): RegExp {
  const [before = '', after = ''] = phrase.split('{name}');
  const head = flexibleWhitespace(escapeRegExp(before));
  const tail = flexibleWhitespace(escapeRegExp(after));
  const name = after.trim() ? '(.+?)' : '(.+)';
  return new RegExp(`^${head}${name}${tail}$`, 'i');
}

export function phrasesFor(lookup: PhraseLookup): readonly string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const locale of LOCALES) {
    for (const phrase of lookup.phrases[locale]) {
      const trimmed = phrase.trim();
      if (!trimmed) continue;
      const key = trimmed.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      result.push(trimmed);
    }
  }
  return result;
}

function matchesPlain(text: string, phrase: string, mode: MatchMode): boolean {
  const haystack = text.toLowerCase();
  const needle = collapseWhitespace(phrase).toLowerCase();
  if (!needle) return false;
  if (mode === 'exact') return haystack === needle;
  if (mode === 'prefix') return haystack.startsWith(needle);
  return haystack.includes(needle);
}

/** Name captured from a `{name}` phrase, or null when nothing matches. */
export function captureName(raw: string, lookup: PhraseLookup): string | null {
  const text = collapseWhitespace(raw);
  for (const phrase of phrasesFor(lookup)) {
    if (!phrase.includes('{name}')) continue;
    const captured = phraseToRegExp(phrase).exec(text)?.[1]?.trim();
    if (captured) return captured;
  }
  return null;
}

export function matchesLookup(raw: string, lookup: PhraseLookup): boolean {
  const text = collapseWhitespace(raw);
  if (captureName(text, lookup)) return true;
  return phrasesFor(lookup).some((phrase) => !phrase.includes('{name}') && matchesPlain(text, phrase, lookup.match));
}

export function matchesAnyLookup(raw: string, lookups: readonly PhraseLookup[]): boolean {
  return lookups.some((lookup) => matchesLookup(raw, lookup));
}

/** Drops a trailing verification word such as "Vérifié" and anything after it. */
export function stripVerifiedMark(raw: string): string {
  let name = collapseWhitespace(raw);
  for (const mark of phrasesFor(LINKEDIN_LOOKUPS.verifiedMark)) {
    name = name.replace(new RegExp(`\\s+${escapeRegExp(mark)}.*$`, 'i'), '').trim();
  }
  return name;
}

export function blockAutomationPhrases(): BlockAutomationPhrases {
  return {
    plusLabels: [...phrasesFor(LINKEDIN_LOOKUPS.plusButton)],
    blockMenuPrefixes: phrasesFor(LINKEDIN_LOOKUPS.blockMenu)
      .map((phrase) => phrase.replace(/\{name\}/gi, '').trim())
      .filter((prefix) => prefix.length > 0),
    blockConfirmLabels: [...phrasesFor(LINKEDIN_LOOKUPS.blockConfirm)],
  };
}

export function resolveUiLocale(override: Locale | null, browserLanguage: string): Locale {
  if (override && (LOCALES as readonly string[]).includes(override)) return override;
  const base = browserLanguage.toLowerCase().split('-')[0] ?? '';
  if ((LOCALES as readonly string[]).includes(base)) return base as Locale;
  return 'en';
}

export function translate(key: UiKey, locale: Locale, vars?: Readonly<Record<string, string>>): string {
  const entry = UI_TEXT[key];
  const raw = entry[locale].trim() || entry.en.trim() || entry.fr.trim();
  if (!vars) return raw;
  return raw.replace(/\{(\w+)\}/g, (full, name: string) => vars[name] ?? full);
}

/**
 * Text LinkedIn renders. Both repost and liked lists are required: a header
 * that matches neither is a direct post, including a like whose reaction
 * verb we have not listed yet.
 */
export const LINKEDIN_LOOKUPS = {
  hidePost: {
    match: 'prefix',
    phrases: phrases(
      ['Masquer le post de {name}', 'Masquer les posts de {name}'],
      ['Hide post by {name}', 'Hide posts by {name}'],
    ),
  },
  openPostMenu: {
    match: 'exact',
    phrases: phrases(['Options'], ['Options']),
  },
  openPostMenuLegacy: {
    match: 'prefix',
    phrases: phrases(
      ['Ouvrir le menu de commandes pour le post de {name}'],
      ['Open control menu for post by {name}'],
    ),
  },
  /** Header fragments. A match classifies the post as a repost. */
  repostHeader: {
    match: 'contains',
    phrases: phrases(
      ['a ajouté un commentaire', 'a reposté ceci', 'a republié ceci', 'a partagé ceci'],
      ['commented', 'reposted th', 'reposted th', 'shared'],
    ),
  },
  /** Header fragments. A match classifies the post as a like or other reaction. */
  likedHeader: {
    match: 'contains',
    phrases: phrases(
      ['aime ce', 'trouve ce', 'célèbre ce', 'soutient ce', 'adore ce'],
      ['likes th', 'finds th', 'celebrates th', 'supports th', 'loves th'],
    ),
  },
  unfollowMenu: {
    match: 'prefix',
    phrases: phrases(['Ne plus suivre {name}'], ['Unfollow {name}']),
  },
  plusButton: {
    match: 'exact',
    phrases: phrases(['Plus'], ['More']),
  },
  blockMenu: {
    match: 'prefix',
    phrases: phrases(['Bloquer {name}'], ['Block {name}']),
  },
  blockConfirm: {
    match: 'exact',
    phrases: phrases(['Bloquer'], ['Block']),
  },
  verifiedMark: {
    match: 'exact',
    phrases: phrases(['Vérifié'], []),
  },
  promoted: {
    match: 'contains',
    phrases: phrases(['Sponsorisé'], ['Promoted']),
  },
} as const satisfies Record<string, PhraseLookup>;

/** Copy the extension itself shows. */
export const UI_TEXT = {
  popupSubtitle: ui('Contrôles du fil LinkedIn', 'LinkedIn feed controls'),
  feedSettingsLabel: ui('Paramètres du fil', 'Feed settings'),
  enableButtonsLabel: ui('Activer les boutons dans le fil', 'Enable Buttons in Feed'),
  enableButtonsDesc: ui('Afficher Ne plus suivre et Bloquer sur les publications', 'Show Unfollow and Block on posts'),
  originalAuthorLabel: ui("Bloquer l'auteur d'origine", 'Block on Original Author'),
  originalAuthorDesc: ui(
    "Afficher Bloquer sur l'auteur d'origine d'un repost ou d'un j'aime",
    'Show Block on the original author of a repost or like',
  ),
  toolbarOrderLabel: ui("Inverser l'ordre de la barre", 'Reverse Toolbar Order'),
  toolbarOrderDesc: ui('Échanger les deux groupes de boutons', 'Swap the two button groups'),
  debugLabel: ui('Mode débogage', 'Debug Mode'),
  debugDesc: ui('Afficher les logs et les aides dans la console', 'Show console logs and helpers'),
  languageLabel: ui('Langue', 'Language'),
  languageDesc: ui('Langue du popup et des boutons du fil', 'Language of the popup and feed buttons'),
  blockedCountLabel: ui('Profils bloqués', 'Blocked profiles'),
  viewBlockedLabel: ui('Voir les profils bloqués', 'View Blocked Profiles'),
  toastBlockStartFailed: ui("Impossible de démarrer le blocage", 'Block failed to start'),
  toastBlocked: ui('Profil bloqué', 'Blocked successfully'),
  toastBlockFailed: ui('Le blocage a échoué', 'Block failed'),
  unsupportedLinkedInLanguage: ui(
    "Cette extension ne prend en charge que le FR et l'EN pour le moment.",
    'This extension only supports FR and EN for now.',
  ),
  unsupportedLinkedInLanguageAction: ui('Passez LinkedIn en anglais.', 'Switch LinkedIn to English.'),
  missingProfileUrl: ui('URL de profil manquante pour cette publication', 'Missing profile URL for this post'),
  optionsAction: ui('Options', 'Options'),
  unfollowAction: ui('Ne plus suivre {name}', 'Unfollow {name}'),
  blockAction: ui('Bloquer {name}', 'Block {name}'),
} as const;

export type UiKey = keyof typeof UI_TEXT;
