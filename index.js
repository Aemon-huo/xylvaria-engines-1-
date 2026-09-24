/**
 * Xylvaria Engines — SillyTavern port
 * ------------------------------------------------------------------
 * This file is a straight port of two scripts originally written for
 * Janitor AI's "Advanced Scripts" sandbox (the Xylvaria Living World
 * Engine, and the Fatal Consequences + Power Scaling & Luck engine).
 *
 * Neither engine's internal logic has been changed AT ALL — every
 * function, table, and formula below (between the "BEGIN" and "END"
 * markers) is byte-for-byte what was pasted into this chat. Only the
 * three lines in each engine that touched Janitor AI's `context`
 * object have a SillyTavern-native replacement sitting around them:
 *
 *   context.chat.last_message   -> the newest user message in `chat`
 *   context.chat.message_count  -> chat.length
 *   context.character.scenario  -> an ephemeral "System" note spliced
 *                                  into the prompt for this generation
 *                                  only (NOT saved into the character
 *                                  card, so it can't balloon over time)
 *
 * This runs as a SillyTavern "prompt interceptor": a function SillyTavern
 * calls right before building the prompt for every real generation
 * (not swipes-preview / dry runs). See manifest.json's
 * "generate_interceptor" field. Docs:
 * https://docs.sillytavern.app/for_contributors/writing-extensions
 *
 * State (character sheet, world clock) is kept on `globalThis`, exactly
 * like the original scripts already did ("best effort" persistence,
 * per their own comments) — this works for the lifetime of the browser
 * tab. It will NOT survive a full page reload. If you want it to
 * survive reloads too, it can be upgraded to use SillyTavern's
 * chatMetadata store instead — ask if you want that version.
 */
globalThis.xylvariaEnginesInterceptor = function (chat, contextSize, abort, type) {
  try {
    // ---- find the newest user message, the way context.chat.last_message did in JAI ----
    var __lastUserMsg = '';
    for (var __i = chat.length - 1; __i >= 0; __i--) {
      if (chat[__i] && chat[__i].is_user) { __lastUserMsg = chat[__i].mes || ''; break; }
    }

    // ---- shared accumulator: both engines append to context.character.scenario in turn ----
    var __scenarioAcc = '';

    // ---- the JAI-shaped `context` object both engines below expect to find in scope ----
    var context = {
      chat: {
        last_message: __lastUserMsg,
        message_count: chat.length
      },
      character: {
        get scenario() { return __scenarioAcc; },
        set scenario(v) { __scenarioAcc = v; }
      }
    };

    // ==================================================================
    // BEGIN: Xylvaria Living World Engine (unmodified — runs first so its
    // world-clock state is on globalThis before the combat engine reads it)
    // ==================================================================
/**
 * Xylvaria Living World Engine (Janitor AI script)
 *
 * Every turn it:
 *  1. Advances a real in-world clock (calendar, seasons, moon, sunrise/sunset).
 *  2. Works out where the player is (Velden, Kalhaar, Drukzul, Sylvantine, passes)
 *     and handles travel time between map places, including closed passes.
 *  3. Builds weather, temperature, light and town schedules for that place/time.
 *  4. Runs background threads, rumors that distort with distance, roaming NPCs
 *     who cross paths again, calendar festivals, and background events.
 *  5. Rolls encounters with real randomness. Monsters are far more likely
 *     at night, dusk, dawn, new moon and in storms, and much less in towns.
 *  6. Writes it all into context.character.scenario as fixed facts.
 *
 * Uses only: context.chat.message_count, context.chat.last_message,
 * context.character.scenario. Wrapped in a function so it can be pasted
 * next to other scripts without name clashes.
 * If Janitor does not keep variables between messages, the clock falls back to
 * message count, and weather, threads, rumors and NPC positions still work
 * because they are computed from the day number.
 */
(function () {
  'use strict';

  // ======================= CONFIG (edit me) =======================
  var START = { year: 1, month: 4, day: 12, hour: 7, minute: 0, place: 'willows' };
  var FALLBACK_MIN_PER_MESSAGE = 10;   // used only if script memory is off
  var MAX_TRAVEL_LEG = 600;            // minutes of travel per turn (10 hours)
  var PX_PER_DAY = 90;                 // map pixels covered per day on foot
  var KEY = '__xylWorldV1';

  var MONTHS = ['Deepwinter', 'Icemelt', 'Thawrise', 'Greenbud', 'Bloomtide', 'Highsun',
                'Suncrest', 'Harvestwane', 'Emberfall', 'Ashfall', 'Duskfrost', 'Starfall'];

  // ======================= MAP DATA =======================
  // x,y are pixel positions on the Xylvaria map image.
  var REGIONS = {
    Velden:     { x: 620,  y: 260, amp: 2.5, terrain: 1.5, h0: 0.05, label: 'Velden (frozen north)' },
    Kalhaar:    { x: 1150, y: 260, amp: 1.2, terrain: 1.3, h0: 0.05, label: 'Kalhaar (desert)' },
    Drukzul:    { x: 200,  y: 570, amp: 1.0, terrain: 1.4, h0: 0.09, label: 'Drukzul (violet island)' },
    Sylvantine: { x: 830,  y: 800, amp: 1.5, terrain: 1.0, h0: 0.03, label: 'Sylvantine (green south)' },
    Mountains:  { x: 820,  y: 520, amp: 2.0, terrain: 1.6, h0: 0.06, label: 'the mountains' },
    Sea:        { x: 100,  y: 900, amp: 1.5, terrain: 1.0, h0: 0.04, label: 'Starfall Sea' }
  };
  var PLACES = {
    'stormhold':      { name: 'Stormhold',      region: 'Velden',     x: 575,  y: 368, town: true },
    'garrukhan':      { name: 'Garrukhan',      region: 'Kalhaar',    x: 1140, y: 397, town: true },
    'noctarim':       { name: 'Noctarim',       region: 'Drukzul',    x: 215,  y: 470, town: true },
    'vulnshore':      { name: 'Vulnshore',      region: 'Drukzul',    x: 200,  y: 663, town: true },
    'celestalis':     { name: 'Celestalis',     region: 'Sylvantine', x: 925,  y: 673, town: true },
    'willows':        { name: 'Willows',        region: 'Sylvantine', x: 810,  y: 870, town: true },
    'frostgate pass': { name: 'Frostgate Pass', region: 'Mountains',  x: 520,  y: 550, town: false, pass: true },
    'sunspire pass':  { name: 'Sunspire Pass',  region: 'Mountains',  x: 820,  y: 510, town: false, pass: true },
    'greystone pass': { name: 'Greystone Pass', region: 'Mountains',  x: 1135, y: 563, town: false, pass: true }
  };
  // Region pseudo-places (used for "somewhere in the wilds of X").
  var REGION_KEY = { Velden: 'velden', Kalhaar: 'kalhaar', Drukzul: 'drukzul', Sylvantine: 'sylvantine', Mountains: 'mountains', Sea: 'starfall sea' };
  for (var rn in REGIONS) {
    PLACES[REGION_KEY[rn]] = { name: 'the wilds of ' + rn, region: rn, x: REGIONS[rn].x, y: REGIONS[rn].y, town: false, wild: true };
  }
  PLACES['mountains'].name = 'the high mountains';
  PLACES['starfall sea'].name = 'the Starfall Sea';
  var NAMEABLE = ['stormhold', 'garrukhan', 'noctarim', 'vulnshore', 'celestalis', 'willows',
                  'frostgate pass', 'sunspire pass', 'greystone pass', 'frostgate', 'sunspire', 'greystone',
                  'velden', 'kalhaar', 'drukzul', 'sylvantine'];
  var ALIAS = { 'frostgate': 'frostgate pass', 'sunspire': 'sunspire pass', 'greystone': 'greystone pass' };
  var SOUTH_COAST = { x: 700, y: 930 };
  var PASS_FOR = { 'Sylvantine|Velden': ['frostgate pass', 'sunspire pass'],
                   'Sylvantine|Kalhaar': ['greystone pass', 'sunspire pass'],
                   'Velden|Kalhaar': ['sunspire pass'] };

  // ======================= WEATHER, TEMPERATURE =======================
  var WEATHER = {
    Velden:     { winter: ['heavy snow', 'blizzard', 'bitter clear cold', 'snow flurries'], spring: ['thaw slush', 'snow flurries', 'cold fog', 'clear and cold'], summer: ['cool clear', 'light rain', 'high wind', 'cold fog'], autumn: ['sleet', 'cold rain', 'early snow', 'clear and cold'] },
    Kalhaar:    { winter: ['clear and mild', 'dust haze', 'cold desert wind', 'light rain'], spring: ['dry heat', 'dust haze', 'sandstorm', 'clear'], summer: ['blistering heat', 'sandstorm', 'dry lightning', 'still furnace air'], autumn: ['dry heat', 'dust haze', 'sandstorm', 'clear and warm'] },
    Drukzul:    { winter: ['violet storm', 'violet fog', 'cold rain', 'arcane lightning'], spring: ['violet fog', 'violet storm', 'cold rain', 'still gloom'], summer: ['violet fog', 'arcane lightning', 'still gloom', 'violet storm'], autumn: ['violet storm', 'violet fog', 'cold rain', 'still gloom'] },
    Sylvantine: { winter: ['cold rain', 'mist', 'clear and cold', 'light snow'], spring: ['light rain', 'mist', 'clear', 'warm shower'], summer: ['warm clear', 'thunderstorm', 'humid haze', 'clear'], autumn: ['mist', 'steady rain', 'crisp clear', 'windy'] },
    Mountains:  { winter: ['heavy snow', 'blizzard', 'icy wind', 'clear and bitter'], spring: ['thaw rain', 'fog', 'meltwater and loose rock', 'clear and cold'], summer: ['clear', 'thunderstorm', 'high wind', 'fog'], autumn: ['sleet', 'fog', 'icy wind', 'clear'] },
    Sea:        { winter: ['gale', 'rough swell', 'fog', 'cold rain'], spring: ['fog', 'rough swell', 'clear', 'squall'], summer: ['calm', 'fog', 'squall', 'clear'], autumn: ['gale', 'fog', 'squall', 'rough swell'] }
  };
  var BASE_TEMP = { Velden: { winter: -16, spring: -2, summer: 12, autumn: -1 }, Kalhaar: { winter: 16, spring: 29, summer: 41, autumn: 30 },
                    Drukzul: { winter: 3, spring: 7, summer: 14, autumn: 8 }, Sylvantine: { winter: 4, spring: 14, summer: 25, autumn: 12 },
                    Mountains: { winter: -14, spring: 0, summer: 10, autumn: -2 }, Sea: { winter: 6, spring: 10, summer: 18, autumn: 11 } };
  var SWING = { Velden: 6, Kalhaar: 20, Drukzul: 5, Sylvantine: 8, Mountains: 9, Sea: 4 };

  // ======================= TIME-OF-DAY DANGER =======================
  var PHASE_MULT = { 'Deep Night': 2.2, 'Night': 1.8, 'Dusk': 1.3, 'Dawn': 1.2, 'Morning': 0.7, 'Midday': 0.6, 'Afternoon': 0.8 };

  // ======================= EVENTS AND CREATURES (edit to your bestiary) =======================
  var EVENTS = {
    day: {
      Sylvantine: ['Barges and carts crowd the river roads, and a temple bell marks the hour.', 'Traders haggle at a crossroads shrine while hunters bring in fresh game.', 'A rider hurries past with sealed letters, mud to the knees.'],
      Velden:     ['Watchmen change shifts on the walls under a hard white sky.', 'Woodcutters haul sledges of timber, breath steaming.', 'A messenger on a shaggy horse rides toward the passes.'],
      Kalhaar:    ['Caravan bells ring as a train leaves for the passes.', 'Water-sellers work the shade while the heat builds.', 'Dust devils spin across the flats and fade.'],
      Drukzul:    ['Violet light flickers under the clouds, and dockhands work with cloths tied over their faces.', 'A patrol in dark lacquered armor marches past without speaking.', 'Ships wait in harbor for the sky to settle.'],
      Mountains:  ['Wind hauls snow off the ridges in long banners.', 'A goat-herder leads animals down a switchback trail.', 'Somewhere above, small rocks clatter down and stop.'],
      Sea:        ['Gulls wheel over fishing boats working the swell.', 'A merchant ship crawls along the horizon.', 'A school of fish turns the water silver, then dark.']
    },
    night: {
      Sylvantine: ['Lantern light moves along distant roads, and owls call from the canopy.', 'Something crashes through the undergrowth and goes quiet.', 'Fog gathers in the river hollows.'],
      Velden:     ['Watch fires burn on the walls, and wolf song rides the wind.', 'Nobody walks the outer streets, and shutters are barred.', 'Frost cracks in the timbers like distant footsteps.'],
      Kalhaar:    ['The desert cools fast, and jackal calls carry over the dunes.', 'Caravan guards double the watch and bank their fires low.', 'Stars burn hard and clear while the sand hisses in the wind.'],
      Drukzul:    ['Purple lightning crawls between the black spires.', 'Curfew bells ring and the streets empty at once.', 'A shape moves across a rooftop and is gone.'],
      Mountains:  ['The cold bites deeper, and ice groans in the rock.', 'A distant rumble might be rockfall, or something walking.', 'Wolves call from the far ridge and are answered nearer.'],
      Sea:        ['Black water slaps the hull, and lantern light shivers on it.', 'Something pale passes under the surface and does not return.', 'The night watch calls the hour, voices thin in the wind.']
    }
  };
  var CREATURES = {
    Sylvantine: { day: ['a dire boar', 'a bandit crew working the road', 'giant forest spiders', 'a feral stag in rut'], night: ['a wolf pack on the hunt', 'a lantern-wisp luring travelers off the path', 'a forest wraith', 'poachers with dogs'] },
    Velden:     { day: ['a hungry snow bear', 'a bandit crew in the pines', 'winter wolves', 'a pack of frost hounds'], night: ['a wolf pack under the moon', 'ice wraiths drifting on the wind', 'a starving snow bear', 'frostbitten raiders'] },
    Kalhaar:    { day: ['giant scorpions', 'a sand-viper nest', 'raiders on fast mounts', 'dust-wyrm tremors under the sand'], night: ['a sand-wyrm hunting by vibration', 'jackal packs', 'raiders striking a campfire', 'stalking desert cats'] },
    Drukzul:    { day: ['violet-touched crawlers', 'a patrol of the ruling court', 'scavengers picking the shore', 'storm-mad beasts'], night: ['shadow-things that hunt by sound', 'storm-drawn wraiths', 'a smuggler ambush', 'hollow-eyed cultists'] },
    Mountains:  { day: ['an eagle-sized roc scouting for prey', 'rockfall stalkers', 'bandits watching the pass', 'a mountain troll'], night: ['a troll wandering the switchbacks', 'wolves closing in', 'mountain wraiths', 'a starving bear'] },
    Sea:        { day: ['pirates in a low fast ship', 'a sea serpent shadow', 'a rogue wave', 'a drifting wreck with something aboard'], night: ['a leviathan shadow under the keel', 'ghost-lights leading toward rocks', 'pirate raiders', 'a drowned ship rising'] },
    Urban:      { day: ['a pickpocket working the crowd', 'a market brawl', 'a guard shakedown', 'a swindler with a forged deed'], night: ['a cutpurse gang', 'the night watch demanding papers', 'a drunk mob', 'an alley robbery'] }
  };

  // ======================= CALENDAR EVENTS =======================
  var FESTIVALS = [
    { m: 12, d: 1,  len: 3, region: 'Velden',     text: 'Frostgate Vigil: torch processions in Velden, taverns packed, watchmen lenient.' },
    { m: 3,  d: 1,  len: 3, region: 'Sylvantine', text: 'Thaw Fair: markets in Willows and Celestalis overflow with traders.' },
    { m: 6,  d: 15, len: 2, region: 'Mountains',  text: 'Sunspire Solstice: pilgrims crowd Sunspire Pass at dawn.' },
    { m: 9,  d: 10, len: 3, region: 'Sylvantine', text: 'Harvest Fair in Willows: music, drink, cheap food.' },
    { m: 12, d: 15, len: 2, region: 'Any',        text: 'Starfall Night: meteors streak over the Starfall Sea and the storms of Drukzul flare violet.' }
  ];

  // ======================= LIVING THREADS =======================
  // start = story day it begins, len = days per stage. fact = what is true where it happens,
  // rumor = the distorted version that travels. Edit or add your own.
  var THREADS = [
    { id: 'avalanche', region: 'Mountains', near: ['Velden', 'Sylvantine'], origin: 'Frostgate Pass', start: 2, len: 5, stages: [
      { fact: 'Snow keeps sliding on the slopes above Frostgate Pass, and a courier from Stormhold is a day late.', rumor: 'They say Frostgate is cursed and swallowed a courier whole.' },
      { fact: 'An avalanche has buried a stretch of the Frostgate road, and caravans queue on the Sylvantine side.', rumor: 'Some claim Stormhold sealed the pass on purpose.' },
      { fact: 'Stormhold sappers are digging the road open, and wolves are following the diggers.', rumor: 'The wolves are said to be the size of horses.' }
    ] },
    { id: 'raids', region: 'Kalhaar', near: ['Mountains', 'Sylvantine'], origin: 'Greystone Pass', start: 4, len: 6, stages: [
      { fact: 'Two caravans near Greystone Pass arrived with their cargo stripped and no guards.', rumor: 'Raiders took a whole caravan and everyone with it.' },
      { fact: 'Garrukhan posts a bounty on the raiders and hires extra guards, and prices rise.', rumor: 'Garrukhan is closing the pass to outsiders.' },
      { fact: 'A raider camp is found abandoned, with tracks leading toward Sunspire Pass.', rumor: 'The raiders are backed by a lord in the capital.' }
    ] },
    { id: 'violet', region: 'Drukzul', near: ['Sea', 'Sylvantine'], origin: 'Vulnshore', start: 7, len: 6, stages: [
      { fact: 'Violet lightning runs farther from the shore each night, and Vulnshore harbor masters delay sailings.', rumor: 'Drukzul is sinking into the sea.' },
      { fact: 'Two ships fail to reach port, and fishermen speak of purple fog over the water.', rumor: 'A whole fleet has been swallowed.' },
      { fact: 'Smugglers profit by running the storm edge, and Noctarim tightens its patrols.', rumor: 'The lord of Noctarim has sealed the island.' }
    ] },
    { id: 'conclave', region: 'Sylvantine', near: ['Mountains'], origin: 'Celestalis', start: 10, len: 5, stages: [
      { fact: 'Scholars and pilgrims arrive in Celestalis, and inns fill and prices climb.', rumor: 'A great gathering at Celestalis will announce something historic.' },
      { fact: 'A quarrel at the gathering ends with a relic missing from the archive.', rumor: 'The relic was stolen by a foreign spy.' },
      { fact: 'The city guard searches every outbound cart, and travelers are delayed at the gates.', rumor: 'Celestalis has closed its gates to everyone.' }
    ] },
    { id: 'patrols', region: 'Mountains', near: ['Velden', 'Kalhaar', 'Sylvantine'], origin: 'Sunspire Pass', start: 13, len: 6, stages: [
      { fact: 'A patrol sent to Sunspire Pass has not reported back.', rumor: 'Soldiers deserted and are hiding in the mountains.' },
      { fact: 'Two more scouts are overdue, and a torn banner is found at the switchbacks.', rumor: 'Something in the pass is eating patrols.' },
      { fact: 'A search party returns with wounded men who say little and will not name the attacker.', rumor: 'The survivors were sworn to silence by someone powerful.' }
    ] }
  ];

  // ======================= ROAMING CAST (same faces keep turning up) =======================
  var CAST = [
    { name: 'Maren Voss',        role: 'courier',            note: 'brisk, underpaid, hears every rumor first',        stay: 2, off: 0, route: ['celestalis', 'frostgate pass', 'stormhold', 'frostgate pass', 'celestalis', 'willows'] },
    { name: 'Old Tobin',         role: 'peddler',            note: 'cheerful, sells small comforts, gossips freely',   stay: 2, off: 1, route: ['willows', 'celestalis', 'sunspire pass', 'greystone pass', 'garrukhan', 'greystone pass', 'celestalis'] },
    { name: 'Captain Ilsevar Rook', role: 'mercenary captain', note: 'dry, careful with money, hates surprises',        stay: 3, off: 2, route: ['stormhold', 'frostgate pass', 'celestalis', 'greystone pass', 'garrukhan'] },
    { name: 'Sister Auralei',    role: 'healer of Celestalis', note: 'gentle, tireless, quietly stubborn',             stay: 4, off: 0, route: ['celestalis', 'willows'] },
    { name: 'Vex',               role: 'smuggler',           note: 'charming, evasive, always knows a back way',       stay: 3, off: 1, route: ['vulnshore', 'noctarim', 'vulnshore', 'willows'] }
  ];

  // ======================= HELPERS =======================
  function hash(str) { var h = 2166136261; for (var i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
  function rng(seed) {
    var a = hash(String(seed));
    return function () {
      a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function pick(r, arr) { return arr[Math.floor(r() * arr.length)]; }
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function esc(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
  function hm(h) { h = ((h % 24) + 24) % 24; var hh = Math.floor(h), mm = Math.round((h - hh) * 60); if (mm === 60) { hh = (hh + 1) % 24; mm = 0; } return pad2(hh) + ':' + pad2(mm); }
  function dist(a, b) { var dx = a.x - b.x, dy = a.y - b.y; return Math.sqrt(dx * dx + dy * dy); }
  function seasonOf(m) { return (m >= 3 && m <= 5) ? 'spring' : (m >= 6 && m <= 8) ? 'summer' : (m >= 9 && m <= 11) ? 'autumn' : 'winter'; }

  // ======================= CLOCK =======================
  function calendar(elapsed) {
    var startMin = ((START.month - 1) * 30 + (START.day - 1)) * 1440 + START.hour * 60 + START.minute;
    var abs = startMin + elapsed;
    var day = Math.floor(abs / 1440);
    var mod = abs - day * 1440;
    var doy = day % 360;
    var storyDay = Math.floor((elapsed + START.hour * 60 + START.minute) / 1440) + 1;
    var month = Math.floor(doy / 30) + 1;
    return { abs: abs, day: day, doy: doy, year: START.year + Math.floor(day / 360), month: month, dom: doy % 30 + 1,
             h: mod / 60, storyDay: storyDay, season: seasonOf(month) };
  }
  function daylight(doy, region) {
    var f = Math.cos(2 * Math.PI * (doy - 165) / 360);
    var amp = REGIONS[region].amp;
    return { sr: 6 - amp * f, ss: 18 + amp * f };
  }
  function phaseOf(h, dl) {
    if (h < dl.sr - 1) { return 'Deep Night'; }
    if (h < dl.sr + 0.5) { return 'Dawn'; }
    if (h < 11.5) { return 'Morning'; }
    if (h < 14.5) { return 'Midday'; }
    if (h < dl.ss - 1.5) { return 'Afternoon'; }
    if (h < dl.ss + 0.5) { return 'Dusk'; }
    return 'Night';
  }
  function moonOf(day) {
    var p = day % 28;
    var name = p < 2 ? 'new moon' : p < 7 ? 'waxing crescent' : p < 9 ? 'first quarter' : p < 14 ? 'waxing gibbous' : p < 16 ? 'full moon' :
               p < 21 ? 'waning gibbous' : p < 23 ? 'last quarter' : p < 27 ? 'waning crescent' : 'new moon';
    return { name: name, light: 0.5 - 0.5 * Math.cos(2 * Math.PI * p / 28) };
  }
  function weatherAt(region, cal) {
    var block = Math.floor(cal.h / 6);
    var r = rng('wx|' + region + '|' + cal.day + '|' + block);
    var name = pick(r, WEATHER[region][cal.season]);
    var temp = BASE_TEMP[region][cal.season] - SWING[region] * (0.5 - 0.5 * Math.cos(2 * Math.PI * (cal.h - 15) / 24));
    if (/blizzard|heavy snow/.test(name)) { temp -= 4; }
    if (/rain|storm|fog|mist/.test(name) && region !== 'Drukzul') { temp -= 2; }
    return { name: name, temp: Math.round(temp) };
  }
  function weatherDanger(name) { return /blizzard|sandstorm|violet storm|arcane lightning|gale/.test(name) ? 1.4 : /storm|squall|fog|violet fog|thunder/.test(name) ? 1.2 : 1; }
  function weatherSlow(name) { return /blizzard|sandstorm|violet storm|gale|heavy snow/.test(name) ? 1.5 : /rain|snow|slush|sleet|storm|squall|rough swell/.test(name) ? 1.2 : 1; }

  // ======================= THREADS =======================
  function threadStage(th, cal) {
    var d = cal.storyDay - 1;
    if (d < th.start) { return -1; }
    var s = Math.floor((d - th.start) / th.len);
    return s >= th.stages.length ? th.stages.length : s;
  }
  function stageOf(id, cal) { for (var i = 0; i < THREADS.length; i++) { if (THREADS[i].id === id) { return threadStage(THREADS[i], cal); } } return -1; }

  // ======================= PASSES =======================
  function passState(key, cal) {
    var st = 'open', why = '';
    var s = cal.season;
    if (key === 'frostgate pass') {
      if (s === 'winter') { st = 'closed'; why = 'deep winter snow and avalanche risk'; }
      else if (s === 'spring') { st = 'difficult'; why = 'thaw slush and avalanches'; }
      else if (s === 'autumn' && cal.month === 11) { st = 'difficult'; why = 'early snowfall'; }
    } else if (key === 'sunspire pass') {
      if (s === 'winter') { st = 'difficult'; why = 'snow on the switchbacks'; }
      else if (s === 'spring') { st = 'difficult'; why = 'rockfalls from the thaw'; }
    } else if (key === 'greystone pass') {
      if (s === 'summer') { st = 'difficult'; why = 'heat and dust storms'; }
    }
    var a = stageOf('avalanche', cal), rd = stageOf('raids', cal), pt = stageOf('patrols', cal);
    if (key === 'frostgate pass' && a === 1) { st = 'closed'; why = 'an avalanche has buried the road'; }
    else if (key === 'frostgate pass' && a === 2 && st !== 'closed') { st = 'difficult'; why = 'sappers still clearing the road'; }
    if (key === 'greystone pass' && (rd === 0 || rd === 1) && st === 'open') { st = 'difficult'; why = 'raiders working the road'; }
    if (key === 'sunspire pass' && (pt === 1 || pt === 2) && st === 'open') { st = 'difficult'; why = 'patrols have gone missing here'; }
    if (st !== 'closed') {
      var r = rng('block|' + key + '|' + Math.floor(cal.day / 10));
      if (r() < 0.10) { st = 'closed'; why = 'a rockslide has blocked the road'; }
    }
    return { state: st, why: why };
  }

  // ======================= ROUTES =======================
  function terrainOf(region) { return REGIONS[region].terrain; }
  function planRoute(fromKey, toKey, cal, msg) {
    var a = PLACES[fromKey], b = PLACES[toKey];
    var ra = a.region, rb = b.region;
    var kind = 'direct', pass = null, days = 0, blocked = null, note = '';
    if (ra === rb || ra === 'Mountains' || rb === 'Mountains') {
      days = dist(a, b) / PX_PER_DAY * terrainOf(rb);
    } else if (ra === 'Drukzul' || rb === 'Drukzul') {
      kind = 'sea';
      var duk = ra === 'Drukzul' ? a : b, main = ra === 'Drukzul' ? b : a;
      days = 4 + dist(SOUTH_COAST, main) / PX_PER_DAY + dist(PLACES['vulnshore'], duk) / PX_PER_DAY * 1.2;
    } else {
      kind = 'pass';
      var pair = (ra < rb) ? ra + '|' + rb : rb + '|' + ra;
      var opts = PASS_FOR[pair] || ['sunspire pass'];
      var chosen = null, reasons = [];
      for (var i = 0; i < opts.length; i++) {
        var ps = passState(opts[i], cal);
        if (ps.state !== 'closed') { chosen = { key: opts[i], ps: ps }; break; }
        reasons.push(PLACES[opts[i]].name + ' is closed (' + ps.why + ')');
      }
      if (!chosen) {
        var forced = /\b(force\w*|anyway|regardless|despite|brave the)\b/.test(msg);
        chosen = { key: opts[0], ps: { state: 'closed', why: passState(opts[0], cal).why } };
        if (!forced) { blocked = reasons.join('; '); }
        else { note = 'FORCED crossing of a closed pass: extremely dangerous'; }
      }
      pass = chosen.key;
      var pp = PLACES[pass];
      days = (dist(a, pp) / PX_PER_DAY) * terrainOf(ra) + (dist(pp, b) / PX_PER_DAY) * terrainOf(rb);
      if (chosen.ps.state === 'difficult') { days *= 1.5; note = PLACES[pass].name + ' is difficult (' + chosen.ps.why + ')'; }
      if (chosen.ps.state === 'closed' && !blocked) { days *= 2; }
      if (opts[0] !== pass && chosen.ps.state !== 'closed') { note += (note ? '; ' : '') + 'using ' + PLACES[pass].name + ' because ' + PLACES[opts[0]].name + ' is shut'; }
    }
    var wx = weatherAt(ra, cal);
    days *= weatherSlow(wx.name);
    if (/\b(ride|riding|horse\w*|mount\w*|on horseback)\b/.test(msg)) { days *= 0.6; note += (note ? '; ' : '') + 'mounted'; }
    return { kind: kind, pass: pass, minutes: Math.max(30, Math.round(days * 1440)), blocked: blocked, note: note,
             forced: /FORCED/.test(note) };
  }
  function regionAtTravel(t) {
    var from = PLACES[t.from].region, to = PLACES[t.to].region;
    var f = 1 - t.left / t.total;
    if (t.kind === 'pass') { return f < 0.35 ? from : f < 0.65 ? 'Mountains' : to; }
    if (t.kind === 'sea') { return f < 0.3 ? from : f < 0.7 ? 'Sea' : to; }
    return f < 0.5 ? from : to;
  }
  function currentRegion(st) { return st.travel ? regionAtTravel(st.travel) : PLACES[st.place].region; }
  function currentKey(st) { return st.travel ? REGION_KEY[regionAtTravel(st.travel)] : st.place; }

  // ======================= INTENT PARSING =======================
  var NUMWORD = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, twelve: 12 };
  function findDest(msg) {
    var i, nm, re;
    for (i = 0; i < NAMEABLE.length; i++) {
      nm = NAMEABLE[i];
      re = new RegExp('\\b(?:to|toward|towards|for|into|reach|reaching|visit|towards)\\s+(?:the\\s+)?(?:city of\\s+|town of\\s+)?' + esc(nm) + '\\b');
      if (re.test(msg)) { return ALIAS[nm] || nm; }
    }
    if (/\b(go|going|travel\w*|head\w*|ride|riding|walk\w*|journey\w*|march\w*|set out|depart\w*|make my way)\b/.test(msg)) {
      var found = [];
      for (i = 0; i < NAMEABLE.length; i++) { if (new RegExp('\\b' + esc(NAMEABLE[i]) + '\\b').test(msg)) { found.push(ALIAS[NAMEABLE[i]] || NAMEABLE[i]); } }
      var uniq = found.filter(function (v, k) { return found.indexOf(v) === k; });
      if (uniq.length === 1) { return uniq[0]; }
    }
    return null;
  }
  function parseDuration(msg) {
    if (/\bhalf an? hour\b/.test(msg)) { return 30; }
    var re = /\b(\d+|a|an|one|two|three|four|five|six|seven|eight|nine|ten|twelve)\s*(minutes?|mins?|hours?|hrs?|days?)\b/g, m;
    while ((m = re.exec(msg)) !== null) {
      var before = msg.slice(Math.max(0, m.index - 25), m.index);
      if (/(for|wait|rest|sleep|stay|camp|linger|meditat|train|study|search|work|spend)/.test(before)) {
        var n = /^\d+$/.test(m[1]) ? parseInt(m[1], 10) : NUMWORD[m[1]];
        var u = m[2].charAt(0);
        return n * (u === 'm' ? 1 : u === 'h' ? 60 : 1440);
      }
    }
    return null;
  }
  function untilMinutes(msg, cal, dl) {
    var m = msg.match(/\buntil\s+(dawn|sunrise|morning|noon|midday|afternoon|dusk|sunset|evening|nightfall|night|midnight)\b/);
    if (!m) { return null; }
    var t = { dawn: dl.sr + 0.1, sunrise: dl.sr + 0.1, morning: 8, noon: 12, midday: 12, afternoon: 15, dusk: dl.ss, sunset: dl.ss, evening: dl.ss, nightfall: dl.ss + 1, night: dl.ss + 1, midnight: 24 }[m[1]];
    var mins = Math.round((t - cal.h) * 60);
    while (mins < 30) { mins += 1440; }
    return mins;
  }

  // ======================= TURN =======================
  function decideAdvance(st, msg, cal) {
    var region0 = currentRegion(st);
    var dl = daylight(cal.doy, region0);
    var out = { minutes: 10, reason: 'conversation', notes: [], blocked: null, arrived: null, sleeping: false, forced: false };
    var dest = findDest(msg);
    var cancel = /\b(stop\w*|halt\w*|turn(?:ing)? back|make camp|set up camp|abandon\w*)\b/.test(msg);
    var cont = /\b(continu\w*|keep going|press on|onward|carry on|move on|ride on|march on|travel\w*|walk\w*|ride|riding|head\w*|journey\w*|set out)\b/.test(msg);
    var here = currentKey(st);

    if (st.travel && cancel) {
      st.place = REGION_KEY[regionAtTravel(st.travel)];
      st.travel = null;
      out.reason = 'stopping on the road'; out.minutes = 15; out.notes.push('Travel halted; the party is now in the open wilds.');
      return out;
    }
    var starting = dest && dest !== here;
    if (starting) {
      var plan = planRoute(here, dest, cal, msg);
      if (plan.blocked) {
        out.blocked = plan.blocked; out.minutes = 30; out.reason = 'learning the way is shut';
        return out;
      }
      st.travel = { from: here, to: dest, total: plan.minutes, left: plan.minutes, kind: plan.kind, pass: plan.pass, forced: plan.forced };
      if (plan.note) { out.notes.push('Route: ' + plan.note + '.'); }
      out.forced = plan.forced;
    }
    if (st.travel && (starting || (cont && !dest))) {
      // Travelers move in daylight, camp at dusk and set out at first light, unless they push through the night.
      var nightMarch = /\b(through the night|by night|at night|push on|night march|without stopping|all night|no rest)\b/.test(msg);
      var winStart = dl.sr + 0.5, winEnd = dl.ss, h = cal.h, wait = 0;
      if (!nightMarch && (h >= winEnd - 0.5 || h < winStart)) {
        wait = Math.round((winStart - h) * 60);
        while (wait < 0) { wait += 1440; }
        h = winStart;
        out.notes.push('The party camps until first light before setting out.');
        out.sleeping = true;
      }
      var avail = nightMarch ? MAX_TRAVEL_LEG : Math.max(30, Math.round((winEnd - h) * 60));
      var leg = Math.min(st.travel.left, avail, MAX_TRAVEL_LEG);
      if (nightMarch) { out.notes.push('The party presses on through the dark, exhausted and exposed.'); }
      else if (leg === avail && st.travel.left > leg) { out.notes.push('The party stops at dusk to make camp.'); }
      out.minutes = wait + leg; out.reason = wait ? 'camped about ' + (Math.round(wait / 6) / 10) + ' hours until first light, then travelled ' + (Math.round(leg / 6) / 10) + ' hours' : 'travel';
      st.travel.left -= leg;
      out.forced = out.forced || !!st.travel.forced;
      if (st.travel.left <= 0) { out.arrived = st.travel.to; }
      return out;
    }
    var dur = parseDuration(msg), until = untilMinutes(msg, cal, dl);
    if (dur !== null) { out.minutes = dur; out.reason = 'waiting/working as stated'; }
    else if (until !== null) { out.minutes = until; out.reason = 'waiting until the stated time'; }
    else if (/\b(sleep\w*|go to bed|turn in|bed down|rest for the night|camp for the night|make camp for the night)\b/.test(msg)) {
      var m = Math.round((dl.sr + 0.5 - cal.h) * 60); while (m < 240) { m += 1440; }
      out.minutes = m; out.reason = 'sleeping until morning'; out.sleeping = true;
    }
    else if (/\bnap\b/.test(msg)) { out.minutes = 90; out.reason = 'a nap'; out.sleeping = true; }
    else if (/\b(wait\w*|linger|loiter)\b/.test(msg)) { out.minutes = 60; out.reason = 'waiting'; }
    else if (/\brest(?! of)\b/.test(msg)) { out.minutes = 60; out.reason = 'resting'; }
    else if (/\b(craft\w*|brew\w*|forge\w*|smith\w*|study\w*|read\w*|train\w*|practice|repair\w*|cook\w*)\b/.test(msg)) { out.minutes = 90; out.reason = 'focused work'; }
    else if (/\b(search\w*|explor\w*|scout\w*|track\w*|forage\w*|hunt\w*|investigat\w*|loot\w*|examin\w*)\b/.test(msg)) { out.minutes = 45; out.reason = 'searching'; }
    else if (/\b(buy\w*|sell\w*|shop\w*|eat\w*|drink\w*|haggle|trade|meal|order)\b/.test(msg)) { out.minutes = 25; out.reason = 'trade and meals'; }
    else if (/\b(attack\w*|fight\w*|strike|stab|slash|shoot\w*|duel\w*|kill\w*)\b/.test(msg)) { out.minutes = 8; out.reason = 'combat'; }
    out.minutes = clamp(out.minutes, 1, 43200);   // up to 30 days per turn
    return out;
  }

  function avgPhaseMult(elapsedEnd, minutes, region) {
    var n = clamp(Math.ceil(minutes / 60), 1, 12), sum = 0;
    for (var i = 0; i < n; i++) {
      var c = calendar(elapsedEnd - minutes + Math.round(minutes * (i + 0.5) / n));
      sum += PHASE_MULT[phaseOf(c.h, daylight(c.doy, region))];
    }
    return sum / n;
  }

  function townSchedule(place, cal, dl) {
    var h = cal.h, out = [];
    out.push('Gates ' + ((h >= dl.sr && h < dl.ss + 1) ? 'open (close at ' + hm(dl.ss + 1) + ')' : 'shut (the watch may open for coin or a good reason)'));
    out.push('market ' + ((h >= 8 && h < 18) ? 'open' : 'closed'));
    out.push('taverns ' + ((h >= 11 || h < 1.5) ? 'open and ' + (h >= 18 || h < 1.5 ? 'busy' : 'quiet') : 'shuttered'));
    if ((place === 'Stormhold' || place === 'Noctarim') && (h >= 22 || h < dl.sr)) { out.push('curfew in force, streets patrolled'); }
    return out.join(', ');
  }

  function run(st, msg, turn) {
    var cal0 = calendar(st.elapsed);
    var region0 = currentRegion(st);
    var dl0 = daylight(cal0.doy, region0);
    var phase0 = phaseOf(cal0.h, dl0);

    var adv = decideAdvance(st, msg, cal0);
    st.elapsed += adv.minutes;
    if (adv.arrived) { st.place = adv.arrived; st.travel = null; }
    var cal = calendar(st.elapsed);
    var region = currentRegion(st);
    var dl = daylight(cal.doy, region);
    var phase = phaseOf(cal.h, dl);
    var moon = moonOf(cal.day);
    var wx = weatherAt(region, cal);
    var placeKey = currentKey(st);
    var place = PLACES[placeKey];
    var inTown = !st.travel && place.town && !/\b(outside|beyond the walls|wilderness|wilds|trail|the road)\b/.test(msg);
    var seed = 'turn|' + turn + '|' + cal.abs;
    var r = rng(seed);
    var lines = [];

    // TIME
    lines.push('TIME: Story day ' + cal.storyDay + ' | ' + cal.dom + ' ' + MONTHS[cal.month - 1] + ', Year ' + cal.year + ' (' + cal.season + ') | ' + hm(cal.h) + ' (' + phase + ') | sunrise ' + hm(dl.sr) + ', sunset ' + hm(dl.ss) + ' | moon: ' + moon.name + (st.fallback ? ' | clock estimated from message count' : ''));
    var hrs = adv.minutes >= 120 ? (Math.round(adv.minutes / 6) / 10) + ' hours' : adv.minutes + ' minutes';
    if (adv.minutes >= 2880) { hrs = (Math.round(adv.minutes / 144) / 10) + ' days'; }
    lines.push('PASSED THIS TURN: about ' + hrs + ' (' + adv.reason + ').');

    // CHANGES
    var changes = [];
    if (phase !== phase0) { changes.push(phase === 'Dusk' ? 'Dusk is falling; shadows lengthen and night creatures begin to stir.' : phase === 'Night' ? 'Night has fallen; monsters and thieves grow bolder.' : phase === 'Dawn' ? 'Dawn is breaking; the night hunters withdraw.' : phase === 'Deep Night' ? 'The deep hours of the night have come; almost nobody is awake.' : ''); if (!changes[changes.length - 1]) { changes.pop(); } }
    if (cal.day !== cal0.day) { changes.push('A new day has begun (' + cal.dom + ' ' + MONTHS[cal.month - 1] + ').'); }
    if (adv.arrived) { changes.push('The party has ARRIVED at ' + PLACES[adv.arrived].name + '.'); }
    for (var n = 0; n < adv.notes.length; n++) { changes.push(adv.notes[n]); }
    if (changes.length) { lines.push('CHANGES: ' + changes.join(' ')); }

    // LOCATION
    var loc;
    if (st.travel) {
      var pct = Math.round((1 - st.travel.left / st.travel.total) * 100);
      loc = 'On the road from ' + PLACES[st.travel.from].name + ' to ' + PLACES[st.travel.to].name + ' (' + pct + '% of the way), in ' + REGIONS[region].label;
    } else { loc = place.name + ', ' + REGIONS[region].label + (inTown ? ' (settlement)' : ' (open country)'); }
    lines.push('LOCATION: ' + loc + '.');
    if (adv.blocked) { lines.push('ROUTE BLOCKED: ' + adv.blocked + '. Travelers and locals confirm it. The party cannot get through unless they force it, and forcing it is close to suicidal.'); }

    // ENVIRONMENT
    var env = 'Weather: ' + wx.name + ', ' + wx.temp + ' C.';
    var light = phase === 'Night' || phase === 'Deep Night' ? (moon.light > 0.75 ? 'bright moonlight, little cover' : moon.light < 0.2 ? 'pitch dark, no moon' : 'dim moonlight') : (phase === 'Dusk' || phase === 'Dawn') ? 'low grey light' : 'full daylight';
    if (/fog|mist/.test(wx.name)) { light += ', visibility short'; }
    env += ' Light: ' + light + '.';
    var hz = [];
    if (wx.temp <= -10) { hz.push('bitter cold: frostbite and hypothermia without proper gear and shelter'); }
    if (wx.temp >= 38) { hz.push('killing heat: dehydration and heatstroke without water and shade'); }
    if (/blizzard|sandstorm|violet storm|arcane lightning|gale/.test(wx.name)) { hz.push('severe weather: travel is slow and risky and visibility is poor'); }
    if (region === 'Drukzul') { hz.push('violet arcane weather; sensitive people feel it in their teeth'); }
    if (region === 'Kalhaar' && (phase === 'Midday' || phase === 'Afternoon') && cal.season !== 'winter') { hz.push('midday sun; moving unshaded drains stamina fast'); }
    if (region === 'Kalhaar' && (phase === 'Night' || phase === 'Deep Night')) { hz.push('desert night cold'); }
    env += ' Hazards: ' + (hz.length ? hz.join('; ') : 'none beyond ordinary risks') + '.';
    if (inTown) { env += ' Town: ' + townSchedule(place.name, cal, dl) + '.'; }
    lines.push('ENVIRONMENT: ' + env);

    // FESTIVAL
    for (var f = 0; f < FESTIVALS.length; f++) {
      var fe = FESTIVALS[f];
      if (cal.month === fe.m && cal.dom >= fe.d && cal.dom < fe.d + fe.len && (fe.region === 'Any' || fe.region === region)) { lines.push('CALENDAR EVENT: ' + fe.text); }
    }

    // BACKGROUND
    var isNight = (phase === 'Night' || phase === 'Deep Night');
    var pool = EVENTS[isNight ? 'night' : 'day'][region];
    var bg = [pick(r, pool)];
    if (r() < 0.5) { var e2 = pick(r, pool); if (e2 !== bg[0]) { bg.push(e2); } }
    lines.push('BACKGROUND MOVEMENT: ' + bg.join(' '));

    // CAST
    var here = [], near = [];
    var dayIdx = cal.storyDay - 1;
    for (var c = 0; c < CAST.length; c++) {
      var npc = CAST[c];
      var pk = npc.route[Math.floor((dayIdx + npc.off) / npc.stay) % npc.route.length];
      var line = npc.name + ', ' + npc.role + ' (' + npc.note + ')';
      if (!st.travel && pk === st.place) { here.push(line); }
      else if (PLACES[pk].region === region) { near.push(npc.name + ' is in ' + PLACES[pk].name); }
    }
    if (here.length) { lines.push('PEOPLE HERE TODAY: ' + here.join('; ') + '. Keep them consistent, and let them remember past meetings.'); }
    if (near.length) { lines.push('PEOPLE NEARBY: ' + near.join('; ') + '.'); }

    // NEWS AND RUMORS
    var news = [];
    for (var t = 0; t < THREADS.length; t++) {
      var th = THREADS[t], stg = threadStage(th, cal);
      if (stg < 0 || stg >= th.stages.length) { continue; }
      var daysIn = (cal.storyDay - 1 - th.start) - stg * th.len;
      var local = (th.region === region) || (place.name === th.origin);
      var isNear = th.near.indexOf(region) >= 0;
      if (local) { news.push('[fact, happening here] ' + th.stages[stg].fact); }
      else if (isNear && daysIn >= 1) { news.push('[rumor, second-hand and exaggerated] ' + th.stages[stg].rumor); }
      else if (!isNear && daysIn >= 3) { news.push('[rumor, garbled by distance] ' + th.stages[stg].rumor); }
    }
    if (news.length) { lines.push('NEWS AND RUMORS (use only what fits naturally, let NPCs get details wrong when marked as rumor): ' + news.slice(0, 3).join(' | ')); }

    // PASSES
    var ps = ['frostgate pass', 'sunspire pass', 'greystone pass'].map(function (k) { var s = passState(k, cal); return PLACES[k].name + ': ' + s.state + (s.why ? ' (' + s.why + ')' : ''); });
    lines.push('PASSES: ' + ps.join('; ') + '.');

    // ENCOUNTER
    var h0 = REGIONS[region].h0;
    var pm = avgPhaseMult(st.elapsed, adv.minutes, region);
    var mm = moon.light < 0.15 ? 1.25 : (moon.light > 0.9 ? 1.15 : 1);
    if (!isNight) { mm = 1; }
    var mult = pm * mm * weatherDanger(wx.name);
    if (inTown) { mult *= 0.2; }
    if (adv.sleeping && !inTown) { mult *= /\b(watch|guard|sentry|fire|ward\w*|inn|room|tavern)\b/.test(msg) ? 0.6 : 1.3; }
    var hours = Math.max(adv.minutes / 60, 0.1);
    var p = clamp(1 - Math.pow(1 - clamp(h0 * mult, 0, 0.9), hours), 0, 0.85);
    var res = 'NONE. Nothing hostile finds the party this turn.';
    var lethal = 'Moderate';
    var roll = Math.random();
    if (roll < p) {
      var u = Math.random();
      var list = CREATURES[inTown ? 'Urban' : region][isNight ? 'night' : 'day'];
      var who = list[Math.floor(Math.random() * list.length)];
      var size = 1 + Math.floor(Math.random() * (isNight ? 4 : 3));
      var tw = Math.random(); var grade = tw < 0.25 ? 'weaker than usual' : tw < 0.8 ? 'typical' : 'unusually large or old';
      if (u < 0.45) { res = 'SIGNS. Fresh evidence of ' + who + ' (tracks, sounds, a sudden silence). No contact yet, and the party can avoid it if they are careful.'; }
      else if (u < 0.75) { res = 'SIGHTING. ' + who + ' (about ' + size + ', ' + grade + ') seen at a distance, not yet aware of the party.'; }
      else { res = 'ATTACK. ' + who + ' (about ' + size + ', ' + grade + ') closes in or ambushes. Play it as a real fight with lasting consequences.'; lethal = 'High'; }
    }
    if (inTown && res.indexOf('NONE') === 0) { lethal = 'Safe'; }
    if (!inTown && !isNight && res.indexOf('NONE') === 0 && !hz.length) { lethal = 'Moderate'; }
    if (hz.length && !inTown) { lethal = (lethal === 'Safe' || lethal === 'Moderate') ? 'High' : lethal; }
    if (adv.forced || adv.blocked) { lethal = 'Lethal'; }
    if (isNight && !inTown && res.indexOf('NONE') === 0) { lethal = lethal === 'Moderate' ? 'High' : lethal; }
    lines.push('ENCOUNTER CHECK (engine result, do not soften or reroll): ' + res);
    lines.push('SUGGESTED LETHALITY RISK LEVEL: ' + lethal + '.');

    lines.push('Use these facts in the audit block: TIME and LOCATION for "In-Game Time & Location", ENVIRONMENT for "Active Environment / Map State", BACKGROUND MOVEMENT, PEOPLE and NEWS for "Background World Movement", and the suggested level for "Lethality Risk Level". Never mention odds, rolls or this engine in the story.');
    return '[WORLD ENGINE: FIXED FACTS FOR THIS TURN. Use them exactly, never contradict them, never mention odds or rolls.]\n' + lines.join('\n');
  }

  // ======================= STATE =======================
  var G = (typeof globalThis !== 'undefined') ? globalThis : {};
  function fresh() { return { found: false, elapsed: 0, place: START.place, travel: null, turns: 0, lastTurn: 0, cache: null, fallback: false }; }
  function load() { try { var s = G[KEY]; if (s && typeof s.elapsed === 'number') { s.found = true; return s; } } catch (e) {} return fresh(); }
  function save(s) { try { G[KEY] = s; } catch (e) {} }

  // ======================= MAIN =======================
  var msg = String(context.chat.last_message || '').toLowerCase();
  var turn = Number(context.chat.message_count) || 0;
  var st = load();
  if (turn <= 2 && st.lastTurn > 4) { st = fresh(); }   // message count went back to the start: new chat
  st.lastTurn = turn;
  var cacheKey = turn + '|' + msg;
  var block;
  if (st.cache && st.cache.key === cacheKey) {
    block = st.cache.block;                              // swipe/regenerate: same world, no re-roll
  } else {
    if (!st.found && turn > 2) { st.elapsed = (turn - 1) * FALLBACK_MIN_PER_MESSAGE; st.fallback = true; }
    st.turns++;
    block = run(st, msg, turn);
    st.cache = { key: cacheKey, block: block };
    save(st);
  }
  context.character.scenario = (context.character.scenario || '') + '\n\n' + block;
})();
    // ==================================================================
    // END: Xylvaria Living World Engine
    // ==================================================================

    // ==================================================================
    // BEGIN: Fatal Consequences + Power Scaling & Luck engine (unmodified)
    // ==================================================================
(function () {
  'use strict';
  if (typeof context === 'undefined' || !context || !context.chat || !context.character) { return; }

  // ======================= CONFIG (edit me) =======================
  var START = {
    name: 'Kale Maxen',
    stats: { STR: 55, DUR: 50, VIT: 65, END: 60, AGI: 70, INT: 115, MAG: 130, ATK: 65, MATK: 75, LUCK: 60 },
    skills: { Shortsword: 170, Parrying: 100, 'Water Magic': 90, Cooking: 130, Bargaining: 110, Streetwise: 90 },
    affinities: ['Lightning', 'Water', 'Wind']        // primary, secondary, tertiary (also the awakening order)
  };
  var STAT_KEYS = ['STR', 'DUR', 'VIT', 'END', 'AGI', 'INT', 'MAG', 'ATK', 'MATK', 'LUCK'];
  var STAT_TOTAL = 745;              // point budget for a generated sheet (== sum of the old fixed START.stats, so pacing vs. the 1000/rank promotion lines is unchanged)
  var STAT_EXPLICIT_MIN = 1, STAT_EXPLICIT_MAX = 999;   // clamp for player-specified stats (999 stays under the first promotion line, so no instant rank-up)
  var STAT_GEN_MIN = 30, STAT_GEN_MAX = 260;            // clamp for auto-generated stats
  var SHOW_ROLLS = false;            // true = narrator may print a "chance / roll" line
  var COMPANION_ROLLS = 4;           // companions that get their own death roll (0 = off)
  var DEBUG = false;                 // true = script errors are printed into the scenario
  var RANKS = ['E', 'D', 'C', 'B', 'A', 'S'];
  var SLOTS = [1, 2, 3, 3, 4, 4];    // element slots per rank
  var DEATH_BASE = [0, 2, 20, 50, 95];   // none, ordinary, dangerous, reckless, suicidal
  var RISK = ['none', 'ordinary', 'dangerous', 'reckless', 'suicidal'];
  var SKILL_TIER = ['Novice', 'Trained', 'Adept', 'Expert', 'Master', 'Grandmaster'];
  var LIGHTNING_MIN_INT = 1500;      // D-500
  var MANA_PER_MAG = 4;
  var AFF_DMG = [1.0, 0.85, 0.7];    // primary, secondary, tertiary spell damage
  var AFF_COST = [0.8, 1.1, 1.3];    // and mana cost
  var LUCK_COOLDOWN = 12;            // messages between LUCK gains
  var LUCK_WINDOW = 120, LUCK_WINDOW_MAX = 6;   // at most +6 LUCK per 120 messages
  var ENEMY_STRIKE = 0.5;            // an enemy's blow is about half its Pressure
  var KEY = '__engineV2', WORLD_KEY = '__xylWorldV1';

  // ======================= HELPERS =======================
  function rint(a, b) { return a + Math.floor(Math.random() * (b - a + 1)); }
  function d100() { return rint(1, 100); }
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  function copy(o) { return JSON.parse(JSON.stringify(o)); }
  function band(v) { return clamp(Math.floor(v / 1000), 0, RANKS.length - 1); }
  function fmt(v) { var b = band(v); return RANKS[b] + '-' + Math.round(v - b * 1000); }
  function pad(t, n) { t = String(t); while (t.length < n) { t += ' '; } return t; }
  function pct(x) { return Math.round(x * 100) + '%'; }
  function nth(n) { return n + (n === 1 ? 'st' : n === 2 ? 'nd' : n === 3 ? 'rd' : 'th'); }
  function weighted(w, st) { var s = 0, t = 0, k; for (k in w) { s += w[k] * (st[k] || 0); t += w[k]; } return t ? s / t : 0; }
  function tierWord(r, table) { var i; for (i = 0; i < table.length; i++) { if (r < table[i][0]) { return table[i][1]; } } return table[table.length - 1][1]; }
  function mkRx(names) { return new RegExp('(?:^|[^a-z])(?:' + names.join('|') + ')'); }   // word-start match, so "bow" never matches "crossbow"
  function fmtSpan(d) { return d < 1 ? Math.max(1, Math.round(d * 24)) + ' hours' : (Math.round(d * 10) / 10) + ' days'; }
  function manaMax(S) { return Math.max(1, S.stats.MAG * MANA_PER_MAG); }

  // ======================= MESSAGE PATTERNS (each one is tested once and shared) =======================
  var RX = {
    sheet:    /\b(status|stats|stat sheet|character sheet|my sheet|power sheet|my power|power level|how strong am i|what can i beat|damage output)\b|\/(?:status|power|sheet)\b/,
    flee:     /\b(flee\w*|escap\w*|retreat\w*|fall back|get away|back off|withdraw\w*|run\w* away)\b/,
    away:     /\b(away from|hid(?:e|ing))\b/,
    hide:     /\bhid(?:e|ing)\b/,
    calam:    /\b(calamity|cataclysm|adiosa)\b/,
    calAct:   /\b(attack\w*|fight\w*|provok\w*|charg\w*|challeng\w*|approach\w*|face|confront\w*|walk\w*|strik\w*)\b/,
    t1:       /\b(hunt\w*|sneak\w*|swim\w*|climb\w*|track\w*|scout\w*|explor\w*|travel\w*|cross\w*|forest|cave|swamp|road)\b/,
    t2:       /\b(attack\w*|fight\w*|battl\w*|charg\w*|duel\w*|ruins|dungeon|descend\w*|ambush\w*|kill\w*|slay\w*|wad(?:e|ing)|strik\w*|stab\w*|shoot\w*)\b/,
    t3:       /\b(ignor\w*|anyway|reckless\w*|blindly|rush in|provok\w*|taunt\w*|mock\w*|cornered|no way out|no escape)\b/,
    calm:     /\b(tavern|inn|market|shop|guild|sleep\w*|eat\w*|buy\w*|chat\w*|talk\w*)\b/,
    absorb:   /\b(absorb\w*|consum\w*|swallow\w*|devour\w*|take in)\b/,
    coreWord: /\b(core|crystal)s?\b/,
    over:     /\b(push(?:ing)? (?:myself|on|through)|past (?:my )?(?:limit|limits|exhaustion)|until i (?:drop|collapse)|overexert\w*|refuse to stop|to exhaustion|every last)\b/,
    atk:      /\b(attack\w*|strik\w*|hit|swing\w*|slash\w*|stab\w*|thrust\w*|shoot\w*|fir(?:e|ing) (?:at|an?|my|the|off)|fight\w*|duel\w*|charg\w*|cleav\w*|smash\w*|punch\w*|kick\w*|throw\w*|hurl\w*|lunge\w*|cut down|technique|combo|finisher|special move)\b/,
    cast:     /\b(cast(?:s|ing|ed)?|conjur\w*|unleash\w*|invok\w*|incantation|chant\w*|channel\w*|spellcast\w*)\b|\b(?:use|using|fire|firing|launch\w*|releas\w*|hurl\w*|shoot\w*|weav\w*|perform\w*|attempt\w*)\b[^.!?]{0,20}\b(?:spell|magic)\w*/,
    launch:   /\b(hurl\w*|blast\w*|launch\w*|shoot\w*|send\w*|summon\w*|releas\w*|throw\w*|fire|firing)\b/,
    weapon:   /\b(sword\w*|arrows?|\w*bow|daggers?|knife|knives|spear\w*|axe\w*|sling\w*|javelin\w*|pistol|rifle)\b/,
    support:  /\b(heal\w*|barrier|ward|protect\w*|mend\w*)\b/,
    big:      /\b(all[- ]out|full power|with everything|maximum|massive|huge|heavy)\b/,
    small:    /\b(small|tiny|weak|quick|light spell|minor)\b/,
    reinf:    /\b(reinforc\w*|enhanc\w* (?:my |his )?(?:body|legs|arms|blade|sword)|strengthen\w* (?:my |his )?body|infus\w* (?:my |his |the )?(?:body|legs|arms|blade|sword)|body enhancement)\b/
  };
  // extra danger (+) or care (-) that shifts a death chance
  var MODS = [
    [/\b(alone|by myself)\b/, 10],
    [/\b(outnumbered|surrounded|swarm\w*)\b/, 15],
    [/\b(wounded|hurt|bleeding|exhausted|drained)\b/, 15],
    [/\b(cornered|no way out|no escape|trapped)\b/, 20],
    [/\b(scout\w*|prepar\w*|plan|planning|planned|careful\w*|slow\w*|cautious\w*|quiet\w*)\b/, -10]
  ];
  // overexertion: [pattern, stat that grows, price paid]
  var OVER = [
    [/\b(cast|spell|mana|channel)\b/, 'MAG', 'burnout: shaking hands, nosebleed, mana running dry'],
    [/\b(focus|concentrate|hold the spell|control)\b/, 'INT', 'backlash: splitting headache, control slipping'],
    [/\b(run|sprint|dodge|dash)\b/, 'AGI', 'strained legs, ragged breath'],
    [/\b(block|guard|tank|take hits|armor)\b/, 'DUR', 'bruised bones, cracked plates'],
    [/\b(lift|swing|carry|drag|smash|hammer|axe)\b/, 'STR', 'torn muscle, trembling arms'],
    [/\b(sword|slash|stab|thrust|strike)\b/, 'ATK', 'blistered hands, reopened cuts'],
    [/\b(march|endure|keep fighting|hold the line)\b/, 'END', 'collapsing exhaustion']
  ];
  var DMG_TIERS = [[0.3, 'a glancing hit that barely registers'], [0.6, 'a light hit'], [1.0, 'a solid hit'], [1.5, 'a heavy hit'], [2.5, 'a crushing hit'], [Infinity, 'a lethal-level hit']];
  var STRIKE_TIERS = [[0.3, 'shrugged off'], [0.6, 'a scrape or bruise'], [1.0, 'a real wound'], [1.6, 'a serious wound (deep cuts, broken bone)'], [2.5, 'crippling'], [Infinity, 'a lethal-level blow']];
  var DIFF = [['trivial', 15], ['easy', 30], ['routine', 60], ['hard', 250], ['difficult', 250], ['expert', 900], ['masterwork', 2200], ['legendary', 4200], ['impossible', 8000]]
    .map(function (d) { return [d[0], d[1], new RegExp('\\b' + d[0] + '\\b')]; });

  // ======================= SKILLS =======================
  // w = governing stats (weights), kind, names = sheet skill names that feed it, reinf = Body Reinforcement allowed.
  // Craft and field entries come first so "forge a hammer" is never read as a weapon attack.
  // Attack entries are only used when the message has an attack verb, and then they win over defense words.
  function K(id, re, w, kind, names, reinf) { return { id: id, re: re, w: w, kind: kind, names: names, reinf: !!reinf, nrx: mkRx(names) }; }
  var SKILLS = [
    K('Smithing', /\b(forge\w*|smith\w*|temper\w*)\b/, { STR: .3, VIT: .2, END: .2, INT: .3 }, 'craft', ['smithing', 'armorsmithing']),
    K('Carpentry', /\b(carpent\w*|woodwork\w*|joinery)\b/, { STR: .25, AGI: .25, INT: .3, END: .2 }, 'craft', ['carpentry']),
    K('Cooking', /\b(cook\w*|bak(?:e|ing)|stew)\b/, { INT: .5, AGI: .3, END: .2 }, 'craft', ['cooking']),
    K('Alchemy', /\b(brew\w*|alchemy|potion\w*)\b/, { INT: .55, MAG: .35, LUCK: .1 }, 'craft', ['alchemy']),
    K('First Aid', /\b(first aid|bandag\w*|stitch\w*)\b/, { INT: .5, AGI: .3, VIT: .2 }, 'craft', ['first aid', 'surgery']),
    K('Herbalism', /\b(herb\w*|forag\w*)\b/, { INT: .5, END: .3, LUCK: .2 }, 'field', ['herbalism', 'foraging']),
    K('Tracking', /\b(track\w*|trail)\b/, { INT: .5, END: .3, AGI: .2 }, 'field', ['tracking', 'survival', 'navigation']),
    K('Stealth', /\b(sneak\w*|stealth\w*|hid(?:e|ing)|creep\w*)\b/, { AGI: .5, INT: .3, LUCK: .2 }, 'field', ['stealth']),
    K('Climbing', /\b(climb\w*|scal(?:e|ing)|swim\w*)\b/, { STR: .3, END: .4, AGI: .3 }, 'field', ['climbing', 'swimming'], 1),
    K('Trapping', /\b(trap\w*|snare\w*)\b/, { INT: .5, AGI: .3, LUCK: .2 }, 'field', ['trapping']),
    K('Riding', /\b(ride|riding|mounted|horseback)\b/, { AGI: .3, END: .3, ATK: .2, INT: .2 }, 'field', ['riding', 'mounted combat']),
    K('Bargaining', /\b(bargain\w*|haggl\w*|negotiat\w*)\b/, { INT: .7, LUCK: .3 }, 'social', ['bargaining', 'persuasion']),
    K('Persuasion', /\b(persuad\w*|convinc\w*|charm\w*)\b/, { INT: .7, LUCK: .3 }, 'social', ['persuasion', 'bargaining']),
    K('Intimidation', /\b(intimidat\w*|menac\w*)\b/, { STR: .3, ATK: .3, INT: .4 }, 'social', ['intimidation']),
    K('Leadership', /\b(rally\w*|command\w*|lead the)\b/, { INT: .5, END: .3, LUCK: .2 }, 'social', ['leadership']),
    K('Shield', /\b(shield\w*|block\w*|buckler)\b/, { DUR: .4, VIT: .25, END: .2, STR: .15 }, 'defense', ['shield', 'buckler'], 1),
    K('Parrying', /\b(parr\w*|deflect\w*)\b/, { AGI: .35, ATK: .3, INT: .2, DUR: .15 }, 'defense', ['parrying'], 1),
    K('Dodging', /\b(dodg\w*|evad\w*|sidestep\w*|duck\w*)\b/, { AGI: .55, END: .25, INT: .2 }, 'defense', ['dodging'], 1),
    K('Greatsword', /\b(greatsword|two-handed sword|claymore)\b/, { STR: .35, VIT: .2, AGI: .1, ATK: .35 }, 'attack', ['greatsword', 'two-handed'], 1),
    K('Throwing', /\b(throwing (?:knife|knives|axe\w*)|javelin\w*|sling\w*)\b/, { AGI: .35, ATK: .35, STR: .3 }, 'attack', ['throwing', 'javelin', 'sling'], 1),
    K('Crossbow', /\b(crossbow)\b/, { ATK: .4, INT: .3, AGI: .15, STR: .15 }, 'attack', ['crossbow']),
    K('Bow and Arrows', /\b(bow|arrows?|archery|longbow|shortbow)\b/, { AGI: .3, ATK: .3, STR: .25, END: .15 }, 'attack', ['bow', 'shortbow', 'longbow', 'archery'], 1),
    K('Fencing', /\b(rapier|dagger|fenc\w*|stiletto|knife|knives)\b/, { AGI: .4, ATK: .3, STR: .15, VIT: .15 }, 'attack', ['rapier', 'dagger', 'fencing'], 1),
    K('Swordsmanship', /\b(sword\w*|blade\w*|saber|sabre|longsword|shortsword|slash\w*)\b/, { STR: .25, VIT: .15, AGI: .3, ATK: .3 }, 'attack', ['swordsmanship', 'sword', 'longsword', 'shortsword', 'saber', 'blades'], 1),
    K('Axes and Blunt', /\b(axe\w*|hatchet|mace|warhammer|hammer|flail|club|cudgel)\b/, { STR: .4, ATK: .3, VIT: .15, AGI: .15 }, 'attack', ['axe', 'mace', 'warhammer', 'flail', 'club', 'handaxe', 'battleaxe'], 1),
    K('Polearms', /\b(spear\w*|pike|halberd|glaive|trident|polearm|lance|quarterstaff|staff)\b/, { STR: .3, ATK: .3, END: .2, AGI: .2 }, 'attack', ['spear', 'pike', 'halberd', 'glaive', 'trident', 'staff', 'quarterstaff', 'spearmanship'], 1),
    K('Unarmed', /\b(punch\w*|kick\w*|brawl\w*|wrestl\w*|grappl\w*|unarmed|fist\w*)\b/, { STR: .35, AGI: .25, END: .2, ATK: .2 }, 'attack', ['unarmed', 'brawling', 'wrestling', 'grappling'], 1)
  ];
  var REINF = { w: { INT: .5, MAG: .5 }, nrx: mkRx(['body reinforcement', 'reinforcement']) };
  var SPELL_W = { MATK: .45, INT: .30, MAG: .25 };          // spell damage: these three only
  var SUPPORT_W = { INT: .45, MAG: .45, MATK: .10 };        // healing and barriers
  var SPELL_SKILL = { Flame: 'flame magic', Water: 'water magic', Wind: 'wind magic', Earth: 'earth magic', Light: 'light magic', Umbra: 'umbra magic', Lightning: 'lightning magic' };
  var SPELL_RX = {}, ek;
  for (ek in SPELL_SKILL) { SPELL_RX[ek] = mkRx([SPELL_SKILL[ek]]); }

  // ======================= ELEMENTS =======================
  var ELEM_RE = {
    Flame: /\b(flames?|fire\w*|burn\w*|embers?)\b/,
    Water: /\b(water\w*|waves?|splash\w*|frost\w*|ice|icy|freez\w*|chill\w*|hail)\b/,
    Wind: /\b(wind\w*|gusts?|gale|air blade)\b/,
    Earth: /\b(earth\w*|stone\w*|rocks?|boulders?|mud|quake)\b/,
    Light: /\b(light(?! spell)|radiant|holy|sunbeam|photon\w*)\b/,
    Umbra: /\b(umbra\w*|shadows?|darkness|void)\b/,
    Lightning: /\b(lightning|thunder\w*|bolts?|shock\w*|spark\w*|electr\w*)\b/
  };
  var ELEMENTS = ['Flame', 'Water', 'Wind', 'Earth', 'Light', 'Umbra', 'Lightning'];

  // ======================= MONSTERS (ONE table: enemy power + core Pressure + core affinity + weakness) =======================
  // Power is on the same scale as stats and core Pressure: E-0 = 0, D-0 = 1000, C-0 = 2000, B-0 = 3000, A-0 = 4000.
  // M(pattern, name, min, max, core affinity stats (first = main), weak elements, boss, no core drop)
  // Specific monsters first, generic ones last.
  function M(re, name, lo, hi, aff, weak, boss, nocore) {
    return { re: re, name: name, lo: lo, hi: hi, aff: aff || null, weak: weak || [], boss: !!boss, nocore: !!nocore };
  }
  var MONSTERS = [
    // slimes
    M(/\brust slimes?\b/, 'Rust Slime', 50, 200, ['DUR', 'VIT']),
    M(/\bbog slimes?\b/, 'Bog Slime', 30, 120, ['VIT', 'END']),
    M(/\bslimes?\b/, 'Slime', 10, 60, ['VIT', 'END']),
    // lowlands
    M(/\bhorned rabbits?\b/, 'Horned Rabbit', 30, 90, ['AGI', 'END']),
    M(/\b(?:giant |lumin )?bats?\b/, 'Bat', 60, 250, ['AGI', 'MAG']),
    M(/\bhobgoblins?\b/, 'Hobgoblin', 1000, 1200, ['ATK', 'AGI']),
    M(/\bgoblins?\b/, 'Goblin', 100, 300, ['ATK', 'AGI']),
    M(/\bstorm alphas?\b/, 'Storm Alpha', 2100, 2400, ['AGI', 'END']),
    M(/\b(?:dire ?(?:wolf|wolves)|frost hounds?)\b/, 'Direwolf', 1000, 1300, ['AGI', 'END'], ['Flame']),
    M(/\bblade tigers?\b/, 'Blade Tiger', 3050, 3400, ['ATK', 'AGI']),
    // Sylvanryth
    M(/\b(?:glasswing )?wisps?\b/, 'Wisp', 200, 700, ['MAG', 'MATK']),
    M(/\bsilverhorn stags?\b/, 'Silverhorn Stag', 1050, 1300, ['AGI', 'END']),
    M(/\bdryads?\b/, 'Dryad', 2100, 2500, ['MAG', 'MATK', 'INT']),
    M(/\bbramble warden\b/, 'Bramble Warden', 2100, 2300, null, ['Flame'], 1),
    M(/\baethel-yew treants?\b/, 'Aethel-yew Treant', 3100, 3600, ['DUR', 'VIT'], ['Flame']),
    M(/\bironwood treants?\b/, 'Ironwood Treant', 2000, 2400, ['DUR', 'VIT'], ['Flame']),
    M(/\btreants?\b/, 'Treant', 2000, 3600, ['DUR', 'VIT'], ['Flame']),
    // Red Mist Forest
    M(/\b(?:mist )?wraiths?\b/, 'Wraith', 2050, 2400, ['MAG', 'MATK', 'INT'], ['Light']),
    M(/\brevenants?\b/, 'Revenant', 1100, 1500, ['ATK', 'DUR'], ['Light']),
    M(/\bghouls?\b/, 'Ghoul', 1000, 1300, ['STR', 'VIT'], ['Light']),
    M(/\bgrave spiders?\b/, 'Grave Spider', 3000, 3300, ['ATK', 'AGI'], ['Flame']),
    // Brenwood
    M(/\b(?:ironbark )?boars?\b/, 'Boar', 1000, 1250, ['STR', 'DUR']),
    M(/\borc lords?\b/, 'Orc Lord', 4000, 4300, ['STR', 'VIT'], null, 1),
    M(/\borcs?\b/, 'Orc', 1100, 1400, ['STR', 'VIT']),
    // Ossuaron's Spine
    M(/\b(?:bonecrag )?gargoyles?\b/, 'Gargoyle', 2000, 2300, ['DUR', 'STR'], ['Wind']),
    M(/\b(?:mountain )?ogres?\b/, 'Ogre', 2100, 2500, ['STR', 'ATK']),
    M(/\b(?:gale )?rocs?\b/, 'Gale Roc', 3000, 3400, ['AGI', 'ATK']),
    M(/\b(?:titanbone )?golems?\b/, 'Golem', 3300, 3800, ['STR', 'DUR'], ['Wind']),
    M(/\bdrakes?\b/, 'Drake', 4000, 4400, ['ATK', 'STR']),
    // Deep Veins
    M(/\bant queens?\b/, 'Ant Queen', 2000, 2300, ['ATK', 'AGI']),
    M(/\b(?:veinborer )?ants?\b/, 'Veinborer Ant', 1000, 1200, ['ATK', 'AGI']),
    M(/\bslagback lizards?\b/, 'Slagback Lizard', 2000, 2300, ['DUR', 'VIT'], ['Water']),
    // Starspine River and Marsh
    M(/\b(?:marsh )?lizardm[ae]n\b/, 'Lizardman', 1100, 1400, ['ATK', 'END']),
    M(/\b(?:river )?serpents?\b/, 'Serpent', 2000, 2300, ['MAG', 'END'], ['Lightning']),
    // bosses and named foes (no core affinity)
    M(/\bbarrow king\b/, 'Barrow King', 3600, 4200, null, ['Light'], 1),
    M(/\bsandglass queen\b/, 'Sandglass Queen', 3000, 3500, null, ['Water'], 1),
    M(/\bhollow duke\b/, 'Hollow Duke', 4000, 4500, null, ['Light'], 1),
    M(/\bkestrel dane\b/, 'Kestrel Dane', 2400, 2800, null, null, 0, 1),
    M(/\b(?:the )?knight\b(?=.*\b(?:telos|tide|lance|black)\b)|\btide rider\b/, 'The Knight', 4500, 5200, null, null, 1, 1),
    M(/\bveliona\b/, 'Veliona Friege', 4300, 4800, null, null, 1, 1),
    M(/\bavy'?vienna\b/, 'Avy\'Vienna', 8000, 9000, null, null, 1, 1),
    M(/\b(?:telos )?leviathan\b|\bsea wyrm\b/, 'Telos Leviathan', 5500, 6500, null, null, 1),
    M(/\btelos\b/, 'Telos', 2500, 4000),
    M(RX.calam, 'Calamity-class being', 9500, 11000, null, null, 1),
    M(/\bdragons?\b/, 'Dragon', 7000, 9000, null, null, 1)
  ];
  // creatures with no table entry: core affinity only (no Pressure range)
  var GENERIC = [
    [/\b(wolf|wolves|hound|cat|panther|stag|hawk|bird|spider|fox|hare|lizard|crawler)\b/, ['AGI', 'END']],
    [/\b(bear|troll|ape|rhino|bull|ox)\b/, ['STR', 'DUR']],
    [/\b(turtle|crab|beetle|tortoise|armored|shell|stone)\b/, ['DUR', 'VIT']],
    [/\b(mage|mana|owl|witch|spirit|elemental|snake)\b/, ['MAG', 'MATK', 'INT']],
    [/\b(lion|tiger|wyvern|raptor|claw|fang)\b/, ['ATK', 'STR']],
    [/\b(moss|husk|regenerating)\b/, ['VIT', 'END']]
  ];
  var CORE_POOL = ['STR', 'AGI', 'VIT', 'END'];
  var GUILD = { iron: 0, bronze: 1, copper: 2, silver: 3, gold: 4, platinum: 5 };
  // core gain multiplier by core rank: E x1, D x2, C x3, then it halves each rank
  var CORE_MULT = [1, 2, 3, 1.5, 0.75, 0.375];

  // ======================= STATE (one sheet, one key) =======================
  var ROOT = (typeof globalThis !== 'undefined') ? globalThis : (typeof self !== 'undefined') ? self : (typeof window !== 'undefined') ? window : (typeof global !== 'undefined') ? global : {};
  function fresh() {
    return {
      found: false, built: false, name: START.name, rank: 0, stats: copy(START.stats), skills: copy(START.skills),
      affinities: copy(START.affinities), known: [],
      mana: -1, enemy: null, drop: null,
      lastAbsorbAt: null, lastOver: -99,
      lastLuckTurn: -99, luckLog: [], turns: 0, lastTurn: 0, cache: null, snap: null
    };
  }
  function load() {
    var s = null, f, k, migrating;
    try { s = ROOT[KEY]; } catch (e) { s = null; }
    if (!s || !s.stats) { return fresh(); }
    migrating = !('built' in s);       // a save from before character creation existed: it already has a real, played sheet
    f = fresh();
    for (k in f) { if (!(k in s)) { s[k] = f[k]; } }
    if (migrating) { s.built = true; if (!s.affinities || !s.affinities.length) { s.affinities = copy(START.affinities); } }
    s.found = true;
    return s;
  }
  function save(s) { try { ROOT[KEY] = s; } catch (e) {} }
  function snapshot(s) { var c = {}, k; for (k in s) { if (k !== 'snap' && k !== 'cache') { c[k] = s[k]; } } return JSON.stringify(c); }
  function restore(snap) { var s = JSON.parse(snap); s.snap = snap; s.cache = null; s.found = true; return s; }

  // ======================= SHEET MATH =======================
  function rating(st) { return st.INT * 0.6 + st.MAG * 0.25 + st.VIT * 0.15; }
  function promoCount(S) {
    var n = 0, line = (S.rank + 1) * 1000, k;
    for (k in S.stats) { if (S.stats[k] >= line) { n++; } }
    return n;
  }
  function luckMod(st) {
    var sum = 0, n = 0, k;
    for (k in st) { sum += st[k]; n++; }
    return clamp(Math.round((sum / n - st.LUCK) / 20), -5, 5);   // max +-5
  }
  // one promotion check + one element-slot check. Returns true if the rank went up.
  function progress(S, out) {
    var ranked = false, first = S.known.length === 0, i, el;
    while (S.rank < RANKS.length - 1 && promoCount(S) >= 3) { S.rank++; ranked = true; }
    if (ranked) { out.push('PROMOTION: the player passed the threshold in 3 attributes and ranks up to ' + RANKS[S.rank] + '. Narrate it as an awakening: an element slot may open and a signature skill may awaken.'); }
    for (i = 0; i < S.affinities.length && S.known.length < SLOTS[S.rank]; i++) {
      el = S.affinities[i];
      if (S.known.indexOf(el) >= 0 || (el === 'Lightning' && S.stats.INT < LIGHTNING_MIN_INT)) { continue; }
      S.known.push(el);
      if (!first) { out.push('ELEMENT: ' + el + ' awakens as a usable element.'); }
    }
    return ranked;
  }

  // ======================= RISK READING =======================
  function classify(m, F) {
    var t = 0;
    if (RX.t1.test(m)) { t = 1; }
    if (RX.t2.test(m)) { t = 2; }
    if (t >= 1 && RX.t3.test(m)) { t = 3; }
    if (RX.calam.test(m) && RX.calAct.test(m)) { t = 4; }
    if (t === 4 && (F.flee || RX.away.test(m))) { t = 2; }
    if (t === 1 && RX.calm.test(m)) { t = 0; }
    if (t === 0 && F.flee) { t = 1; }
    return t;
  }
  function msgMods(m) {
    var t = 0, i;
    for (i = 0; i < MODS.length; i++) { if (MODS[i][0].test(m)) { t += MODS[i][1]; } }
    if (RX.flee.test(m)) { t -= 20; }
    return t;
  }

  // ======================= DEATH ROLL (used by danger AND by core backlash) =======================
  function deathRoll(S, base, m, label, out) {
    var chance = clamp(base + msgMods(m) + luckMod(S.stats), 2, 95), r = d100(), dead = r <= chance, c = [], i;
    out.push('FATAL CHECK (' + label + '): the player ' + (dead
      ? 'DIES. Narrate the death with weight: the body, the name, who is left. No rescue, no undoing, no reset.'
      : 'survives. Injuries, costs and consequences of the action still apply.'));
    for (i = 1; i <= COMPANION_ROLLS; i++) { c.push(nth(i) + ' ' + (d100() <= chance ? 'DIES' : 'survives')); }
    if (c.length) { out.push('COMPANIONS exposed to the same danger, most exposed first: ' + c.join('; ') + '. Ignore entries beyond the companions present. Their deaths are permanent and played with weight.'); }
    if (SHOW_ROLLS) { out.push('ROLL DATA (may be shown as a dice line): chance ' + chance + '%, rolled ' + r + '.'); }
    return dead;
  }

  // ======================= CORE ABSORPTION =======================
  function findMonster(m) {
    var i;
    for (i = 0; i < MONSTERS.length; i++) { if (MONSTERS[i].re.test(m)) { return MONSTERS[i]; } }
    return null;
  }
  function coreInfo(m) {
    var mon = findMonster(m), aff = mon ? mon.aff : null, i;
    for (i = 0; !aff && i < GENERIC.length; i++) { if (GENERIC[i][0].test(m)) { aff = GENERIC[i][1]; } }
    return { mon: mon, aff: aff, known: !!aff };
  }
  // "E-120" or "d300" -> 120 or 1300 on the continuous scale
  function parsePressure(m) {
    var r = m.match(/\b([edcbas])-?(\d{1,4})\b/);
    return r ? RANKS.indexOf(r[1].toUpperCase()) * 1000 + parseInt(r[2], 10) : null;
  }
  function absorbBand(S, P) {
    var d = (P - rating(S.stats)) / P;
    if (d > 0.5) { return { name: 'auto', pass: 0, gain: 0 }; }
    if (d > 0.2) { return { name: 'hard', pass: 50 - Math.round((d - 0.2) * 100), gain: 0.5 }; }
    if (d > 0) { return { name: 'risky', pass: 100 - Math.round(d * 250), gain: 1 }; }
    return { name: 'safe', pass: 100, gain: 1 };
  }
  function coreGain(v, P) {
    var sr = Math.floor(v / 1000), cr = Math.min(Math.floor(P / 1000), CORE_MULT.length - 1);
    return cr < sr ? rint(0, 1) : Math.round(rint(5, 20) * CORE_MULT[cr]);   // trickle if the core is below the stat's rank
  }
  // days the body needs before the next core. A mind at twice the core's Pressure needs none.
  function settleNeed(S, P) { return (0.5 + P / 1000) * clamp(2 - S.stats.INT / Math.max(P, 1), 0, 1); }
  function nowDays(turn) {
    var w = null;
    try { w = ROOT[WORLD_KEY]; } catch (e) { w = null; }
    return (w && typeof w.elapsed === 'number') ? w.elapsed / 1440 : turn / 24;   // no world clock: about 12 exchanges per day
  }
  function feltWord(S, P) {
    var r = P / Math.max(rating(S.stats), 1);
    return r <= 1 ? 'faint' : r <= 1.3 ? 'heavy' : r <= 2 ? 'crushing' : 'unbearable';
  }
  // resolves the absorption. Returns true if the player dies.
  function absorb(S, P, m, out, types, now) {
    var b = absorbBand(S, P), need = settleNeed(S, P), st = S.stats, gains = [], i, k, g;
    var since = typeof S.lastAbsorbAt === 'number' ? now - S.lastAbsorbAt : 1e9;
    var weakMag = st.MAG < P * 0.5, weakVit = st.VIT < P * 0.5;
    var passed = b.name === 'safe' ? true : b.name === 'auto' ? false : d100() <= b.pass;
    S.lastAbsorbAt = now;
    if (!passed) {
      out.push('CORE: absorption FAILED with a violent backlash (Mana Sickness, burning veins, control lost).');
      return deathRoll(S, b.name === 'auto' ? DEATH_BASE[3] : DEATH_BASE[2], m, 'core backlash', out);
    }
    if (since < need) {
      out.push('CORE: absorption FAILED to take. The previous core has not settled and the body is still full, so this core gives no gain and causes Mana Sickness (dizziness, nausea, cold sweats). The core is wasted. It needed about ' + fmtSpan(need - since) + ' more.');
      return false;
    }
    for (i = 0; i < types.length; i++) {
      k = types[i];
      g = Math.round(coreGain(st[k], P) * b.gain * (i === 0 ? 1 : 0.5));
      if (g > 0) { st[k] += g; gains.push(k + ' +' + g); }
    }
    out.push('CORE: absorption SUCCEEDED' + (b.name === 'hard' ? ' barely, the strain halves the gain' : b.name === 'risky' ? ' at a cost' : ' cleanly') + '.');
    out.push('STAT GAINS: ' + (gains.length ? gains.join(', ') : 'none (the core was too weak for these stats)') + '.');
    if (weakMag) { out.push('Weak link: the mana pool was too thin for this core. Mana Sickness and burnout follow.'); }
    if (weakVit) { out.push('Weak link: the body was too frail for this core. Internal damage follows and recovery is long.'); }
    out.push(need <= 0
      ? 'This core is far below the user\'s mind, so it settles at once. No waiting is needed before the next one.'
      : 'The body needs about ' + fmtSpan(need) + ' to settle before the next core of this strength. A sharper mind shortens it; taking one sooner gives no gain and causes Mana Sickness.');
    return false;
  }
  // decides the Pressure and affinity, then resolves immediately - no free warning turn. Returns 'dead' | 'ok'.
  function coreTurn(S, m, turn, out) {
    var info = coreInfo(m), types = info.aff, P = parsePressure(m), now, soon;
    if (P === null && S.drop && (!info.mon || info.mon.name === S.drop.name)) {   // the core the last kill left behind
      P = S.drop.P; types = S.drop.aff || types; S.drop = null;
    }
    if (P === null) {
      P = info.mon ? rint(info.mon.lo, info.mon.hi)
        : S.rank * 1000 + (/\b(tiny|small|weak|young|cub|pup|minor|faint)\b/.test(m) ? rint(10, 70) : rint(20, 400));
    }
    if (!types) { types = [CORE_POOL[rint(0, CORE_POOL.length - 1)]]; }
    P = Math.max(P, 1);
    now = nowDays(turn);
    soon = typeof S.lastAbsorbAt === 'number' && (now - S.lastAbsorbAt) < settleNeed(S, P);
    out.push('SENSATION: the core feels ' + feltWord(S, P) + ' as it is taken in' + (soon ? ', and the body still feels full from the last one' : '') + '. Show this through sensation (weight, heat, a hum in the bones), never with numbers - then resolve the outcome below in the same beat.');
    return absorb(S, P, m, out, types, now) ? 'dead' : 'ok';
  }

  // ======================= OVEREXERTION =======================
  function overexert(S, m, turn, out) {
    var stat = 'END', cost = 'collapsing exhaustion', i, g;
    for (i = 0; i < OVER.length; i++) { if (OVER[i][0].test(m)) { stat = OVER[i][1]; cost = OVER[i][2]; break; } }
    if (turn - S.lastOver >= 3) {
      g = rint(1, 5);
      S.stats[stat] += g; S.lastOver = turn;
      out.push('OVEREXERTION: ' + stat + ' +' + g + '. The cost is real: ' + cost + '. Show it in the prose.');
    } else {
      out.push('OVEREXERTION again without rest: no gain, only lasting damage (' + cost + '). The body has not recovered.');
    }
  }

  // ======================= ENEMY AND DAMAGE =======================
  function detectEnemy(m) {
    var mon = findMonster(m), r, b;
    if (mon) { return mon; }
    r = m.match(/\b([edcbas])[- ]rank\b/);                                // "c-rank foe" (never "crank" or "drank")
    if (r) { b = RANKS.indexOf(r[1].toUpperCase()); return { name: r[1].toUpperCase() + '-rank foe', lo: b * 1000 + 150, hi: b * 1000 + 850, aff: null, weak: [], boss: b >= 4, nocore: false }; }
    r = m.match(/\b(iron|bronze|copper|silver|gold|platinum)[- ]?(?:rank|ranked)\b/);
    if (r) { b = GUILD[r[1]]; return { name: r[1] + '-rank foe', lo: b * 1000 + 150, hi: b * 1000 + 850, aff: null, weak: [], boss: b >= 4, nocore: true }; }
    return null;
  }
  function adopt(S, mon) {
    if (!mon || (S.enemy && S.enemy.name === mon.name)) { return; }
    S.enemy = { name: mon.name, power: rint(mon.lo, mon.hi), wounds: 0, toughness: mon.boss ? 5 : 3, weak: mon.weak, boss: mon.boss, aff: mon.aff, nocore: mon.nocore };
  }
  function weakMult(elems, e) {
    var i;
    for (i = 0; i < elems.length; i++) { if (e.weak && e.weak.indexOf(elems[i]) >= 0) { return 1.25; } }
    return 1;
  }
  function techniqueBand(m) {
    if (/\b(legendary|mythic|forbidden)\b/.test(m)) { return 4; }
    if (/\b(ultimate|secret art|finisher|final technique)\b/.test(m)) { return 3; }
    if (/\b(signature|special move)\b/.test(m)) { return 2; }
    return 0;
  }
  // The kill gate: 2+ ranks above cannot be hurt at all, 1 rank above needs an overwhelming hit, luck never changes it.
  function hitEnemy(S, out, dmg, crit) {
    var e = S.enemy, ratio = dmg / Math.max(e.power, 1), eb = band(e.power), gap = eb - S.rank;
    var canHurt = true, canKill = true, note = '', f, state;
    if (eb >= 5 && S.rank < 4) { canHurt = false; canKill = false; note = 'This being is calamity-class. The user cannot hurt it at all at this level, and no luck changes that. Only fleeing, hiding or the actions of far stronger beings matter.'; }
    else if (gap >= 2) { canHurt = false; canKill = false; note = 'This foe is two or more ranks above the user. The attack cannot wound it in any lasting way, and the foe can kill the user easily. Only escape, terrain or stronger allies matter.'; }
    else if (gap === 1) { canKill = ratio >= 1.25; note = canKill ? 'This foe is one rank above the user, and only an overwhelming, well-prepared hit can kill it.' : 'This foe is one rank above the user. It can be hurt but not killed by this hit.'; }
    if (canHurt && ratio >= 0.3) { e.wounds += Math.min(ratio, 2.5) * (gap === 1 ? 0.6 : 1); }
    out.push('RESULT on ' + e.name + ': ' + (canHurt ? tierWord(ratio, DMG_TIERS) : 'no effect') + (crit ? ' (critical hit)' : '') + '.');
    if (note) { out.push(note); }
    if (canKill && e.wounds >= e.toughness) {
      out.push('ENEMY: DEFEATED. ' + e.name + ' dies or collapses.');
      if (!e.nocore) { S.drop = { P: e.power, aff: e.aff, name: e.name }; }   // remembered for a later "absorb the core"
      S.enemy = null;
      return;
    }
    f = e.wounds / e.toughness;
    state = !canHurt ? 'unharmed' : f < 0.25 ? 'barely hurt' : f < 0.5 ? 'hurt' : f < 0.75 ? 'badly hurt and may flee if it has the wit' : 'nearly finished';
    if (!canKill && f >= 0.75) { state += ', but the user cannot finish it'; }
    out.push('ENEMY: ' + e.name + ' is ' + state + '.');
  }
  function retaliate(S, m, out) {
    var e = S.enemy, en = null, i, def, label = 'unaided body';
    if (!e) { return; }
    for (i = 0; i < SKILLS.length; i++) { if (SKILLS[i].kind === 'defense' && SKILLS[i].re.test(m)) { en = SKILLS[i]; break; } }
    def = weighted({ DUR: .4, VIT: .3, END: .3 }, S.stats);
    if (en) { def = skillCalc(S, en).pow; label = en.id; }
    out.push('ENEMY BLOW (if ' + e.name + ' lands one while the user defends with ' + label + '): ' + tierWord(e.power * ENEMY_STRIKE / Math.max(def, 1), STRIKE_TIERS) + '.');
  }

  // ======================= SKILL + SPELL ACTIONS =======================
  function skillLevel(skills, rx) {
    var best = 0, k;
    for (k in skills) { if (rx.test(k.toLowerCase())) { best = Math.max(best, skills[k]); } }
    return best;
  }
  function sf(level, base) { return 0.7 + 0.3 * Math.min(level / Math.max(base, 1), 2); }   // 0.7 untrained ... 1.3 well above the stats
  function skillCalc(S, en) {
    var base = weighted(en.w, S.stats), lv = skillLevel(S.skills, en.nrx), f = sf(lv, base);
    return { base: base, lv: lv, f: f, pow: base * f };
  }
  function findSkill(m) {
    var atk = RX.atk.test(m), fallback = null, i, e;
    for (i = 0; i < SKILLS.length; i++) {
      e = SKILLS[i];
      if (!e.re.test(m)) { continue; }
      if (e.kind === 'attack') { if (atk) { return e; } continue; }
      if (!fallback) { fallback = e; }
    }
    return fallback;
  }
  // Elements are only read from the few words after the casting verb, so scenery ("behind the rock", "near the fire") is ignored.
  function elementsIn(m) {
    var i = m.search(RX.cast), w, found = [], k, p;
    if (i < 0) { i = m.search(RX.launch); }
    w = i < 0 ? m : m.slice(i).split(/\s+/).slice(0, 7).join(' ');
    for (k in ELEM_RE) { p = w.search(ELEM_RE[k]); if (p >= 0) { found.push([p, k]); } }
    found.sort(function (a, b) { return a[0] - b[0]; });
    return found.map(function (x) { return x[1]; });
  }

  function spellTurn(S, m, elems, out) {
    var st = S.stats, mm = manaMax(S), known = S.known, support = RX.support.test(m), notes = [], main, ai, i, pen;
    var strength, sMult, sCost, adv, lv, eff, base, cost, frac, tb, mb, power, crit;
    if (S.mana < 0) { S.mana = mm; }
    S.mana = Math.min(S.mana, mm);
    main = elems[0] || known[0] || 'Water';
    if (known.indexOf(main) < 0) {                                       // element not awakened: backlash, mana lost
      pen = Math.round(Math.min(S.mana, mm * 0.25));
      S.mana -= pen;
      out.push(main === 'Lightning' && st.INT < LIGHTNING_MIN_INT
        ? 'SPELL FAILED: Lightning is the user\'s primary affinity but cannot be used yet. The mind cannot hold it (it needs about D-500 INT). The current arcs back through the caster: sparks along the skin, a jolt to the arms, a burst of static, a drained feeling. A painful backlash, not a weapon.'
        : 'SPELL FAILED: ' + main + ' is not an element the user can use yet. The mana gathers and slips away with nothing to show for it.');
      out.push('MANA: lost to the failed attempt, now ' + pct(S.mana / mm) + '.');
      return;
    }
    elems = elems.filter(function (x) { return known.indexOf(x) >= 0; });
    if (!elems.length) { elems = [main]; }
    ai = S.affinities.indexOf(main); if (ai < 0) { ai = 2; }
    strength = RX.big.test(m) ? 'heavy' : RX.small.test(m) ? 'light' : 'standard';
    sMult = strength === 'heavy' ? 1.5 : strength === 'light' ? 0.6 : 1;
    sCost = strength === 'heavy' ? 2 : strength === 'light' ? 0.5 : 1;
    adv = S.enemy ? weakMult(elems, S.enemy) : 1;
    lv = skillLevel(S.skills, SPELL_RX[main]);
    eff = 1 - 0.25 * Math.min(1, lv / Math.max(st.INT, 1));              // skill makes casting cheaper, never stronger
    base = weighted(support ? SUPPORT_W : SPELL_W, st);
    cost = base * sCost * AFF_COST[ai] * (adv > 1 ? 0.8 : 1) * eff;
    frac = S.mana / mm;
    tb = techniqueBand(m); mb = band(lv);
    power = base * sMult * AFF_DMG[ai] * adv * (0.9 + Math.random() * 0.2);
    if (tb > mb) { power *= 0.5; notes.push('The named technique is beyond the user\'s training (' + SKILL_TIER[mb] + ' tier in ' + main + ' magic). Only a clumsy, weaker version comes out.'); }
    if (S.mana < cost) { power *= S.mana / cost; notes.push('Not enough mana for the full spell. It comes out thin and control slips.'); cost = S.mana; }
    else if (frac <= 0.25) { power *= 0.85; notes.push('Mana is low. Control is shaky and the cast is weaker.'); }
    crit = !support && Math.random() < clamp(0.03 + st.LUCK / 2500, 0.03, 0.25);
    if (crit) { power *= 1.5; }
    S.mana = Math.max(0, S.mana - cost);
    out.push('ACTION: ' + (support ? 'support' : 'attack') + ' spell, ' + elems.join(' + ') + ', ' + strength + ' strength' +
      (ai === 1 ? ' (secondary affinity: rough and a little weak)' : ai === 2 ? ' (tertiary affinity: clumsy)' : '') +
      '. Spell power comes only from INT, MAG and MATK; skill only makes casting cheaper and steadier.');
    if (adv > 1) { out.push('Elemental advantage applies against the target.'); }
    for (i = 0; i < notes.length; i++) { out.push(notes[i]); }
    out.push('MANA: now ' + pct(S.mana / mm) + (S.mana / mm <= 0.25 ? ' (shaky control, and the user is vulnerable in melee if it runs out)' : '') + '.' +
      (S.mana <= 0 ? ' Mana is EMPTY: no more spells, real exhaustion, and the user is genuinely vulnerable in a fight.' : ''));
    if (support) { out.push('Support strength: about ' + SKILL_TIER[band(power)] + ' tier, modest and steady.'); return; }
    if (S.enemy) { hitEnemy(S, out, power, crit); retaliate(S, m, out); }
    else { out.push('No target named yet: treat it as ' + tierWord(power / 200, DMG_TIERS) + ' against an ordinary E-rank foe.'); }
  }

  function skillTurn(S, m, en, out) {
    var st = S.stats, mm = manaMax(S), c = skillCalc(S, en), tier = SKILL_TIER[band(c.lv)], notes = [], rf = 1;
    var rb, rl, rp, phys = ['STR', 'DUR', 'VIT', 'END', 'AGI'], pw, ps, avg, cost, power, crit, diff, dn, r, chance, ok, i, k;
    if (S.mana < 0) { S.mana = mm; }
    S.mana = Math.min(S.mana, mm);
    if (en.reinf && RX.reinf.test(m)) {                                  // Body Reinforcement: costs mana, adds a capped bonus
      rb = weighted(REINF.w, st); rl = skillLevel(S.skills, REINF.nrx); rp = rb * sf(rl, rb);
      pw = 0; ps = 0;
      for (i = 0; i < phys.length; i++) { k = phys[i]; pw += en.w[k] || 0; ps += (en.w[k] || 0) * st[k]; }
      avg = pw ? ps / pw : st.STR;
      cost = 0.35 * rp;
      if (S.mana >= cost) {
        rf = 1 + clamp(0.15 * rp / Math.max(avg, 1), 0, 0.4);
        S.mana -= cost;
        notes.push('Body Reinforcement is active: the body is stronger and faster for this action, and it costs mana (now ' + pct(S.mana / mm) + ').');
      } else { notes.push('Not enough mana to reinforce the body. It sputters out and the action is unaided.'); }
    }
    power = c.base * c.f * rf * (0.9 + Math.random() * 0.2);
    if (techniqueBand(m) > band(c.lv)) { power *= 0.5; notes.push('The named technique is beyond the user\'s training (' + tier + ' tier in ' + en.id + '). Only a clumsy basic version happens.'); }
    crit = en.kind === 'attack' && Math.random() < clamp(0.03 + st.LUCK / 2500, 0.03, 0.25);
    if (crit) { power *= 1.5; }
    out.push('ACTION: ' + en.id + ' (skill tier ' + tier + '). Its output comes from ' + Object.keys(en.w).join(', ') + (rf > 1 ? ', boosted by Body Reinforcement' : '') + '.');
    if (c.lv === 0) { out.push('The user has no training in this skill, so the action is clumsy and weaker.'); }
    for (i = 0; i < notes.length; i++) { out.push(notes[i]); }
    if (en.kind === 'attack') {
      if (S.enemy) { hitEnemy(S, out, power, crit); retaliate(S, m, out); }
      else { out.push('No target named yet: treat it as ' + tierWord(power / 200, DMG_TIERS) + ' against an ordinary E-rank foe.'); }
    } else if (en.kind === 'defense') {
      if (S.enemy) { retaliate(S, m, out); } else { out.push('Defense strength: about ' + SKILL_TIER[band(power)] + ' tier.'); }
    } else {                                                             // craft / field / social: a real skill check
      diff = 60; dn = 'routine';
      for (i = 0; i < DIFF.length; i++) { if (DIFF[i][2].test(m)) { diff = DIFF[i][1]; dn = DIFF[i][0]; } }
      r = power / diff;
      chance = clamp(Math.round(100 / (1 + Math.exp(-2.2 * (r - 1)))), 3, 97) + clamp(Math.round(st.LUCK / 100), 0, 8);
      if (r < 0.25) { chance = Math.round(chance * r / 0.25); }
      chance = clamp(chance, 3, 97);
      ok = d100() <= chance;
      out.push('SKILL CHECK vs a ' + dn + ' task: ' + (ok ? 'SUCCESS' : 'FAILURE') + '. Narrate it that way, and a failure has a real cost.');
      if (SHOW_ROLLS) { out.push('ROLL DATA (may be shown as a dice line): chance ' + chance + '%.'); }
    }
  }

  // ======================= LUCK ADVANCEMENT =======================
  // LUCK grows from gambles, narrow escapes, lucky finds and kindness, with a cooldown and a cap. Luck only bends tight odds.
  function luckTurn(S, m, turn, out) {
    var L = S.stats.LUCK, e = S.enemy, trig = null, chance = 0, text = '', recent = 0, gain, i;
    if (/\b(gambl\w*|bet|wager\w*|roll the dice|take a chance|risk it|leap of faith)\b/.test(m)) {
      trig = 'gamble'; chance = clamp(15 + L / 20, 15, 60); text = 'The gamble pays off, modestly: a small reward or a small break, never a miracle.';
    } else if (e && band(e.power) > S.rank && (RX.flee.test(m) || RX.hide.test(m))) {
      trig = 'narrow escape'; chance = clamp(10 + L / 25, 10, 45); text = 'A small piece of luck helps the escape (a loose stone, a hesitation, a gap in the brush). It does not remove the danger.';
    } else if (/\b(search\w*|look for|loot\w*|rummag\w*|dig\w*)\b/.test(m)) {
      trig = 'lucky find'; chance = clamp(8 + L / 30, 8, 40); text = 'A small lucky find turns up (a few coins, a useful herb, a decent core).';
    } else if (/\b(help\w*|gave|give|shar\w*|donat\w*)\b/.test(m) && /\b(stranger|beggar|child|traveler|traveller|villager|injured|hungry)\b/.test(m)) {
      trig = 'kindness'; chance = 12; text = 'The kindness is remembered, and a small good turn comes back later.';
    }
    if (!trig || Math.random() * 100 >= chance) { return; }
    out.push('LUCK EVENT (' + trig + '): ' + text);
    S.luckLog = S.luckLog.filter(function (t) { return turn - t.turn <= LUCK_WINDOW; });
    for (i = 0; i < S.luckLog.length; i++) { recent += S.luckLog[i].gain; }
    if (turn - S.lastLuckTurn < LUCK_COOLDOWN || recent >= LUCK_WINDOW_MAX) { out.push('Luck has been kind recently, so nothing changes in the user\'s fortune yet.'); return; }
    gain = Math.min(L >= 700 ? 1 : L >= 300 ? rint(1, 2) : rint(1, 3), LUCK_WINDOW_MAX - recent);
    S.stats.LUCK += gain; S.lastLuckTurn = turn; S.luckLog.push({ turn: turn, gain: gain });
    out.push('The user\'s luck grows (LUCK +' + gain + '). Luck only bends tight odds. It never turns a hopeless fight into a win or a rank gap into a kill.');
  }

  // ======================= SHEET (ONE screen: status + power) =======================
  function sheetText(S, full) {
    var st = S.stats, mm = manaMax(S), mana = S.mana < 0 ? mm : Math.min(S.mana, mm), total = 0, L = [], n = 0, k, i, r, en, lv;
    for (k in st) { total += st[k]; }
    function c(name) { return pad(name, 5) + pad(fmt(st[name]), 8); }
    L.push('═══ SHEET ═══ [PRIVATE]');
    L.push('Name    ' + (S.name || '———'));
    L.push('Rank    ' + RANKS[S.rank] + '   Promo ' + Math.min(promoCount(S), 3) + '/3   Total ' + Math.round(total));
    L.push('', '── BODY ──', c('STR') + c('ATK'), c('DUR') + c('AGI'), c('VIT') + c('END'));
    L.push('', '── MIND, MANA & FORTUNE ──', c('INT') + c('MAG'), c('MATK') + c('LUCK'));
    L.push('Mana    ' + Math.round(mana) + '/' + Math.round(mm) + ' (' + pct(mana / mm) + ')');
    if (!full) { return L.join('\n'); }
    r = Math.round(rating(st));
    L.push('', '── POWER ──');
    L.push('Spell power    ' + fmt(weighted(SPELL_W, st)) + ' (INT, MAG, MATK)');
    L.push('Absorb rating  ' + r + ' (safe vs core Pressure <= ' + r + ')');
    L.push('Elements       ' + (S.known.length ? S.known.join(', ') : 'none') + '  [' + SLOTS[S.rank] + ' slots] (Lightning needs INT D-500)');
    L.push('Affinity order ' + S.affinities.join(' > ') + '  (primary > secondary > tertiary — sets spell power/cost)');
    L.push('', '── SKILLS ──');
    for (k in S.skills) {
      lv = S.skills[k]; en = null;
      for (i = 0; i < SKILLS.length; i++) { if (SKILLS[i].nrx.test(k.toLowerCase())) { en = SKILLS[i]; break; } }
      L.push(pad(k, 16) + pad(fmt(lv), 8) + pad(SKILL_TIER[band(lv)], 12) + (en ? 'power ' + fmt(skillCalc(S, en).pow) : ''));
      n++;
    }
    if (!n) { L.push('(none)'); }
    L.push('', 'Kill gate: nothing 2+ ranks above your own can be hurt; S-rank needs A-rank.');
    L.push('Script memory: ' + (S.found ? 'working' : 'fresh sheet') + ' (turn ' + S.turns + ')');
    return L.join('\n');
  }

  // ======================= CHARACTER CREATION (runs once, turn 1 only) =======================
  // Reads the player's opening message. An explicit block ("stats: STR:80 DUR:60 VIT:70 END:65
  // AGI:75 INT:100 MAG:110 ATK:70 MATK:80 LUCK:65" / "skills: Shortsword 170, Cooking 90" /
  // "affinities: Water, Wind, Umbra") is used as given - stats are only clamped to a safe range,
  // never rescaled, so the player's numbers are respected. Otherwise any skills/elements named
  // anywhere in the opening message are picked up by keyword (reusing the same SKILLS/ELEM_RE
  // tables the rest of the engine already matches actions against), and stats are generated
  // leaning toward whatever was found - or a random spread if the message gives no hints at all.
  // Either way the point budget for a generated sheet equals STAT_TOTAL (== the old fixed
  // sheet's total), so pacing against the 1000-per-rank promotion lines is unchanged.
  function cap(s) { return s.replace(/\b\w/g, function (c) { return c.toUpperCase(); }); }
  function parseStats(m) {
    var found = {}, n = 0, i, key, re, mt, avg = 0;
    for (i = 0; i < STAT_KEYS.length; i++) {
      key = STAT_KEYS[i].toLowerCase();
      re = new RegExp('\\b' + key + '\\s*[:=]?\\s*(\\d{1,3})\\b');
      mt = re.exec(m);
      if (mt) { found[STAT_KEYS[i]] = clamp(parseInt(mt[1], 10), STAT_EXPLICIT_MIN, STAT_EXPLICIT_MAX); n++; }
    }
    if (n < 8) { return null; }                                     // too few tags to be a deliberate stat block
    for (i = 0; i < STAT_KEYS.length; i++) { if (STAT_KEYS[i] in found) { avg += found[STAT_KEYS[i]]; } }
    avg = Math.round(avg / n);
    for (i = 0; i < STAT_KEYS.length; i++) { if (!(STAT_KEYS[i] in found)) { found[STAT_KEYS[i]] = avg; } }
    return found;
  }
  function parseSkills(m) {
    var mt = /skills\s*:/.exec(m), chunk, end, parts, out = {}, j, part, pm, lvl, any = false;
    if (!mt) { return null; }
    chunk = m.slice(mt.index + mt[0].length);
    end = chunk.search(/\b(affinities|stats)\s*:/);
    if (end >= 0) { chunk = chunk.slice(0, end); }
    parts = chunk.split(',');
    for (j = 0; j < parts.length; j++) {
      part = parts[j].trim();
      if (!part) { continue; }
      pm = /^(.*?)\s+(\d{1,3})$/.exec(part);
      if (!pm) { continue; }
      lvl = clamp(parseInt(pm[2], 10), 1, STAT_EXPLICIT_MAX);
      out[cap(pm[1].trim())] = lvl;                                  // keep the player's own label (sheetText finds the matching SKILLS entry for the power column on its own)
      any = true;
    }
    return any ? out : null;
  }
  function parseAffinities(m) {
    var mt = /affinities\s*:/.exec(m), chunk, end, parts, out = [], j, part, k;
    if (!mt) { return null; }
    chunk = m.slice(mt.index + mt[0].length);
    end = chunk.search(/\b(skills|stats)\s*:/);
    if (end >= 0) { chunk = chunk.slice(0, end); }
    parts = chunk.split(/,|\band\b/);
    for (j = 0; j < parts.length; j++) {
      part = parts[j].trim();
      if (!part) { continue; }
      for (k = 0; k < ELEMENTS.length; k++) {
        if (ELEM_RE[ELEMENTS[k]].test(part) && out.indexOf(ELEMENTS[k]) < 0) { out.push(ELEMENTS[k]); break; }
      }
    }
    return out.length ? out : null;
  }
  function detectSkills(m) {
    var found = [], i;
    for (i = 0; i < SKILLS.length; i++) { if (SKILLS[i].nrx.test(m)) { found.push(SKILLS[i]); } }
    return found;
  }
  function detectAffinities(m) {
    var found = [], k, p;
    for (k in ELEM_RE) { p = m.search(ELEM_RE[k]); if (p >= 0) { found.push([p, k]); } }
    found.sort(function (a, b) { return a[0] - b[0]; });
    return found.map(function (x) { return x[1]; });
  }
  function genStats(weights) {
    var w = {}, total = 0, out = {}, sum = 0, big = -1, biggest, i, k;
    for (i = 0; i < STAT_KEYS.length; i++) {
      k = STAT_KEYS[i];
      w[k] = ((weights && weights[k]) || 0) + 1;                    // every stat keeps a non-zero floor
      w[k] *= (0.85 + Math.random() * 0.3);                         // real random jitter - not a memorized spread
      total += w[k];
    }
    for (i = 0; i < STAT_KEYS.length; i++) {
      k = STAT_KEYS[i];
      out[k] = clamp(Math.round((w[k] / total) * STAT_TOTAL), STAT_GEN_MIN, STAT_GEN_MAX);
      sum += out[k];
      if (out[k] > big) { big = out[k]; biggest = k; }
    }
    out[biggest] = clamp(out[biggest] + (STAT_TOTAL - sum), STAT_GEN_MIN, STAT_GEN_MAX * 2);   // fold rounding drift into the largest stat
    return out;
  }
  function buildCharacter(S, m, out) {
    if (S.built) { return false; }
    var stats, xSkills, xAff, kwSkills, kwAff, i, k, weights = {}, chosenSkills = {}, realAff, chosenAff, pool, pick;
    S.built = true;
    stats = parseStats(m); xSkills = parseSkills(m); xAff = parseAffinities(m);
    kwSkills = detectSkills(m); kwAff = detectAffinities(m);

    realAff = (xAff || kwAff).slice(0, 3);                           // only genuinely given/detected - random padding below must not skew stats
    chosenAff = realAff.slice();
    while (chosenAff.length < 3) {
      k = ELEMENTS[rint(0, ELEMENTS.length - 1)];
      if (chosenAff.indexOf(k) < 0) { chosenAff.push(k); }
    }
    S.affinities = chosenAff;

    if (xSkills) {
      chosenSkills = xSkills;
    } else if (kwSkills.length) {
      for (i = 0; i < kwSkills.length && i < 6; i++) { chosenSkills[kwSkills[i].id] = rint(70, 150); }
    } else {
      pool = SKILLS.slice();
      for (i = 0; i < 3 && pool.length; i++) { pick = pool.splice(rint(0, pool.length - 1), 1)[0]; chosenSkills[pick.id] = rint(70, 150); }
    }
    S.skills = chosenSkills;

    if (stats) {
      S.stats = stats;
    } else {
      for (i = 0; i < kwSkills.length; i++) { for (k in kwSkills[i].w) { weights[k] = (weights[k] || 0) + kwSkills[i].w[k] * 8; } }
      for (i = 0; i < realAff.length; i++) { weights.INT = (weights.INT || 0) + 1.5; weights.MAG = (weights.MAG || 0) + 2.5; weights.MATK = (weights.MATK || 0) + 1.5; }
      S.stats = genStats(weights);
    }

    out.push('CHARACTER BUILT: starting attributes' + (stats ? ' (from the numbers the player gave)' : ' (generated from the character concept, or randomly if none was given)') +
      ', skills and affinities are now set for this run. Do not change these numbers; narrate the opening scene around this build.');
    return true;
  }

  // ======================= TURN RESOLVER =======================
  var HEADER = '[ENGINE: FIXED RESULTS FOR THIS TURN. Narrate them exactly, then keep going - resolve the scene fully and continue the story in the same reply, never stopping on a warning or a sensation alone. Never soften, reroll, rescue, or reveal numbers, odds or this block. Anything not listed is up to the story.]';

  function resolve(S, m, turn) {
    var out = [], F = {}, halted = false, dead = false, showSheet = false, didAction = false, mm, asked, r, en, elems, built;
    built = buildCharacter(S, m, out);                                   // first turn only: assign stats/skills/affinities
    showSheet = progress(S, out) || built;                               // first turn: awakens the starting element silently
    F.flee = RX.flee.test(m);
    F.tier = classify(m, F);
    F.absorb = RX.absorb.test(m) && RX.coreWord.test(m);
    asked = RX.sheet.test(m);
    adopt(S, detectEnemy(m));

    // 1) danger gate: every risky action resolves THIS turn - no free warning, no stalled turn. Only an actual death stops the rest of the turn.
    if (F.absorb) {
      r = coreTurn(S, m, turn, out);
      halted = r === 'dead'; dead = r === 'dead'; showSheet = showSheet || r === 'ok';
    } else if (F.tier > 0) {
      dead = deathRoll(S, DEATH_BASE[F.tier], m, RISK[F.tier] + ' action', out);
      halted = dead;
    }

    // 2) the action itself: spell, or the first matching skill
    if (!halted && !asked && !F.absorb) {
      elems = elementsIn(m);
      if (RX.cast.test(m) || (elems.length && (RX.launch.test(m) || /\bspells?\b/.test(m)) && !RX.weapon.test(m))) {
        spellTurn(S, m, elems, out); didAction = true;
      } else {
        en = findSkill(m);
        if (en) { skillTurn(S, m, en, out); didAction = true; }
      }
    }

    // 3) mana recovery (turns without an action)
    mm = manaMax(S);
    if (S.mana < 0) { S.mana = mm; }
    if (!didAction) {
      if (/\b(sleep\w*|go to bed|camp for the night)\b/.test(m)) { S.mana = mm; }
      else if (/\b(rest\w*|meditat\w*|catch my breath|recover\w*)\b/.test(m)) { S.mana = Math.min(mm, S.mana + mm * 0.25); }
      else { S.mana = Math.min(mm, S.mana + mm * 0.03); }
    }

    // 4) luck, escape, overexertion
    if (!halted) { luckTurn(S, m, turn, out); }
    if (F.flee && S.enemy && !didAction && !halted) {
      out.push('The user breaks away from ' + S.enemy.name + '. It is no longer engaged unless it pursues.');
      S.enemy = null;
    }
    if (F.over && !halted) { overexert(S, m, turn, out); showSheet = true; }

    // 5) growth: one promotion + element check, then the sheet if asked or if something changed
    if (progress(S, out)) { showSheet = true; }
    if (asked || showSheet) {
      out.push('SHEET: copy the block below exactly, in a code block, at the end of your reply. Change no number. Only the player sees it; no one else in the world can read it.\n' + sheetText(S, asked || built));
    }
    return out.length ? HEADER + '\n' + out.join('\n') : '';
  }

  // ======================= MAIN =======================
  var msg = String(context.chat.last_message || '').toLowerCase();
  var turn = Number(context.chat.message_count) || 0;
  var S = load(), block = '', ckey = turn + '|' + msg;
  if (turn <= 2 && S.lastTurn > 2) { S = fresh(); }                      // message count went back to the start: new chat
  if (turn > 0 && S.snap && S.cache && S.cache.turn === turn && S.cache.key !== ckey) { S = restore(S.snap); }   // edited message, same turn: undo the first attempt
  S.lastTurn = turn;
  if (S.cache && S.cache.key === ckey) {
    block = S.cache.block;                                               // swipe / regenerate: same result, no re-roll
  } else {
    S.snap = snapshot(S);
    S.turns++;
    try { block = resolve(S, msg, turn); }
    catch (err) { block = DEBUG ? '[ENGINE ERROR: ' + (err && err.message) + ']' : ''; }
    S.cache = { key: ckey, turn: turn, block: block };
  }
  save(S);
  if (block) { context.character.scenario = (context.character.scenario || '') + '\n\n' + block; }
})();
    // ==================================================================
    // END: Fatal Consequences + Power Scaling & Luck engine
    // ==================================================================

    // ---- inject the combined result as an ephemeral system note, right before ----
    // ---- the newest message, so it's part of this generation's prompt only.  ----
    if (__scenarioAcc) {
      chat.splice(Math.max(chat.length - 1, 0), 0, {
        is_user: false,
        is_system: true,
        name: 'System',
        send_date: Date.now(),
        mes: __scenarioAcc
      });
    }
  } catch (err) {
    console.error('[Xylvaria Engines]', err);
  }
};
