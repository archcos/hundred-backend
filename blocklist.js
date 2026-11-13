// Starter blocklist. Loaded into the database ONCE (first start); after that the admin panel's
// "Blocked words" tab is the source of truth, so removing a word there keeps it removed.
// Matching is whole-word and also catches endings (s/ed/ing/er), repeated letters, spacing and
// leetspeak — see blockedPattern() in lib.js. Ordinary swearing is deliberately NOT here:
// people swear in heartfelt letters. Add it from the admin panel if you want it blocked.
// Content warning: this file lists slurs so the site can refuse them.
export const DEFAULT_BLOCKED_WORDS = [
  // Racial and ethnic slurs
  'nigger', 'nigga', 'coon', 'jigaboo', 'porch monkey', 'chink', 'gook', 'jap', 'zipperhead', 'slant eye',
  'spic', 'wetback', 'beaner', 'kike', 'raghead', 'towelhead', 'paki', 'redskin', 'injun',

  // Homophobic, transphobic and ableist slurs
  'faggot', 'fag', 'tranny', 'shemale', 'retard',

  // Explicit sexual content
  'porn', 'porno', 'pornhub', 'blowjob', 'handjob', 'cumshot', 'creampie', 'gangbang', 'bukkake',
  'hentai', 'dick pic', 'send nudes', 'nudes', 'onlyfans', 'camgirl', 'escort service', 'child porn', 'lolicon',

  // Harassment and hate slogans
  'kys', 'kill yourself', 'neck yourself', 'heil hitler', 'sieg heil', 'white power', '1488',

  // Spam and scams
  'free bitcoin', 'crypto giveaway', 'double your money', 'sugar daddy',
  'casino bonus', 'viagra', 'cialis',
];
