// Tables of the Trophy database, matching the Django models in trophy/models.py.
// Table and column names are the ones Django's migrations create, so a dump made here
// loads into the Django app with `loaddata` and vice versa.

export const SCHEMA_VERSION = 1;

// Version of the browser <-> room protocol. The page (docs/js/data.js) has the same number;
// when they differ the page asks to be reloaded (or the worker to be redeployed).
export const PROTOCOL = 2;

// Sheet rules (same constants as trophy/models.py)
export const FREE_POWERS = 3;
export const FREE_SKILLS = 4;
export const BACKPACK_SLOTS = 6;
export const RUIN_MAX = 6;
export const HOARD_MAX = 50;
export const AMMO_MAX = 3;
export const BASE_BURDEN = 1;

// model name (as in Django dumps, without the "trophy." prefix) -> table description.
// fields: column -> default value. The default's type decides how values are stored and
// sent: string, number, boolean (stored 0/1), 'json' (stored as text), 'datetime'.
// fk: columns that reference a character (dumped under the name without "_id").
// max: maximum lengths of CharFields.
export const MODELS = {
  character: {
    table: 'trophy_character',
    fields: {
      name: '', gender: '', player_name: '', occupation: '', background: '', look: '',
      drive: '', conditions: '', notes: '',
      ruin: 1, hoard: 0, coin: 0, hunt_tokens: 0, burden_offset: 0,
      hireling: false, archived: false, created_at: 'datetime',
    },
    max: { name: 120, gender: 60, player_name: 120, occupation: 200, background: 200, look: 200 },
  },
  power: childModel('trophy_power'),
  skill: childModel('trophy_skill'),
  householdmember: childModel('trophy_householdmember'),
  foundequipment: childModel('trophy_foundequipment'),
  combatitem: childModel('trophy_combatitem', { kind: 'armor', marked: false, ammo: 0 }, { kind: 10 }),
  backpackitem: childModel('trophy_backpackitem', { uses: 0, slot: 0 }),
  roller: { table: 'trophy_roller', fields: { mat: 'json', sections: 'json', updated_at: 'datetime' } },
  monster: {
    table: 'trophy_monster',
    fields: {
      endurance: 0, name: '', description: '', habits: 'json', defences: '', weakness: '',
      position: 0, created_at: 'datetime',
    },
    max: { name: 200, description: 400, weakness: 300 },
  },
  equipment: { table: 'trophy_equipment', fields: {} },
  overview: { table: 'trophy_overview', fields: {} },
};

function childModel(table, extra = {}, extraMax = {}) {
  return {
    table,
    fields: { character_id: 0, name: '', ...extra, position: 0 },
    fk: ['character_id'],
    max: { name: 200, ...extraMax },
  };
}

// The sheet's child lists: the short "kind" used by the sheet -> model name.
export const CHILD_KINDS = {
  power: 'power',
  skill: 'skill',
  household: 'householdmember',
  combat: 'combatitem',
  found: 'foundequipment',
  backpack: 'backpackitem',
};

// SQL in the form Django's SQLite backend writes it.
export const DDL = [
  `CREATE TABLE IF NOT EXISTS "trophy_character" ("id" integer NOT NULL PRIMARY KEY AUTOINCREMENT, "name" varchar(120) NOT NULL, "gender" varchar(60) NOT NULL, "player_name" varchar(120) NOT NULL, "occupation" varchar(200) NOT NULL, "background" varchar(200) NOT NULL, "look" varchar(200) NOT NULL, "drive" text NOT NULL, "conditions" text NOT NULL, "notes" text NOT NULL, "ruin" smallint unsigned NOT NULL CHECK ("ruin" >= 0), "hoard" smallint unsigned NOT NULL CHECK ("hoard" >= 0), "coin" integer unsigned NOT NULL CHECK ("coin" >= 0), "hunt_tokens" integer unsigned NOT NULL CHECK ("hunt_tokens" >= 0), "burden_offset" integer NOT NULL, "hireling" bool NOT NULL, "archived" bool NOT NULL, "created_at" datetime NOT NULL)`,
  ...['power', 'skill', 'householdmember', 'foundequipment'].map(m =>
    `CREATE TABLE IF NOT EXISTS "trophy_${m}" ("id" integer NOT NULL PRIMARY KEY AUTOINCREMENT, "name" varchar(200) NOT NULL, "position" integer unsigned NOT NULL CHECK ("position" >= 0), "character_id" bigint NOT NULL REFERENCES "trophy_character" ("id") DEFERRABLE INITIALLY DEFERRED)`),
  `CREATE TABLE IF NOT EXISTS "trophy_combatitem" ("id" integer NOT NULL PRIMARY KEY AUTOINCREMENT, "name" varchar(200) NOT NULL, "kind" varchar(10) NOT NULL, "marked" bool NOT NULL, "ammo" smallint unsigned NOT NULL CHECK ("ammo" >= 0), "position" integer unsigned NOT NULL CHECK ("position" >= 0), "character_id" bigint NOT NULL REFERENCES "trophy_character" ("id") DEFERRABLE INITIALLY DEFERRED)`,
  `CREATE TABLE IF NOT EXISTS "trophy_backpackitem" ("id" integer NOT NULL PRIMARY KEY AUTOINCREMENT, "name" varchar(200) NOT NULL, "uses" smallint unsigned NOT NULL CHECK ("uses" >= 0), "slot" smallint unsigned NOT NULL CHECK ("slot" >= 0), "position" integer unsigned NOT NULL CHECK ("position" >= 0), "character_id" bigint NOT NULL REFERENCES "trophy_character" ("id") DEFERRABLE INITIALLY DEFERRED)`,
  `CREATE TABLE IF NOT EXISTS "trophy_roller" ("id" integer NOT NULL PRIMARY KEY AUTOINCREMENT, "mat" text NOT NULL CHECK ((JSON_VALID("mat") OR "mat" IS NULL)), "sections" text NOT NULL CHECK ((JSON_VALID("sections") OR "sections" IS NULL)), "updated_at" datetime NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS "trophy_monster" ("id" integer NOT NULL PRIMARY KEY AUTOINCREMENT, "endurance" smallint unsigned NOT NULL CHECK ("endurance" >= 0), "name" varchar(200) NOT NULL, "description" varchar(400) NOT NULL, "habits" text NOT NULL CHECK ((JSON_VALID("habits") OR "habits" IS NULL)), "defences" text NOT NULL, "weakness" varchar(300) NOT NULL, "position" integer unsigned NOT NULL CHECK ("position" >= 0), "created_at" datetime NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS "trophy_equipment" ("id" integer NOT NULL PRIMARY KEY AUTOINCREMENT)`,
  `CREATE TABLE IF NOT EXISTS "trophy_overview" ("id" integer NOT NULL PRIMARY KEY AUTOINCREMENT)`,
  ...['power', 'skill', 'householdmember', 'foundequipment', 'combatitem', 'backpackitem'].map(m =>
    `CREATE INDEX IF NOT EXISTS "trophy_${m}_character_id_idx" ON "trophy_${m}" ("character_id")`),
  // Not part of the Django schema: room bookkeeping.
  `CREATE TABLE IF NOT EXISTS "trophy_meta" ("key" text NOT NULL PRIMARY KEY, "value" text NOT NULL)`,
  // Ids of recently applied operations, so an operation resent after a lost reply is not applied twice.
  `CREATE TABLE IF NOT EXISTS "trophy_applied" ("oid" text NOT NULL PRIMARY KEY, "at" integer NOT NULL, "result" text NOT NULL)`,
];
