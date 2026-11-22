// Fort Duhrin (Hearthfire): what scavengers do in town between incursions. The text is the
// same for every character, as in the Django app; each character keeps only which boxes are
// marked (hearthfire_marks: {key: true}) and the Equipment shopkeeper's secret
// (hearthfire_secret). Blocks: p (instruction), check (a box to mark), bullet (no box),
// secret (the secret line), boxes (a row of small boxes), hoard_number, household_list.
export const HEARTHFIRE = [
 {
  "title": "Hoard",
  "blocks": [
   {
    "t": "hoard_number"
   },
   {
    "t": "p",
    "text": "Stash Coin in your Hoard to get closer to achieving your Drive and retiring. Complete both of the following the first time you do so:"
   },
   {
    "t": "check",
    "key": "hoard-ft-0",
    "text": "Answer: Where do you keep your hoard so no one can find it?"
   },
   {
    "t": "check",
    "key": "hoard-ft-1",
    "text": "Narrate a flashback of the moment you adopted your Drive."
   },
   {
    "t": "p",
    "text": "Each time thereafter, mark any unmarked item from the list below."
   },
   {
    "t": "check",
    "key": "hoard-0",
    "text": "Narrate a flashback of your favorite childhood memory."
   },
   {
    "t": "check",
    "key": "hoard-1",
    "text": "Answer: Which Sister have you dedicated yourself to and how do you thank her for her help? The next time you show thanks to her during an incursion, clear one mental Condition."
   },
   {
    "t": "check",
    "key": "hoard-2",
    "text": "Answer: You've seen a sign or an omen about what's to come. What is it? Take an extra light die on one Hunt Roll or Risk Roll if you describe how the sign or omen is manifesting in the scene."
   },
   {
    "t": "check",
    "key": "hoard-3",
    "text": "Narrate a flashback of a triumph related to your Background."
   },
   {
    "t": "check",
    "key": "hoard-4",
    "text": "Narrate a flashback of a triumph related to your Occupation."
   },
   {
    "t": "check",
    "key": "hoard-5",
    "text": "Narrate a present day scene showing how you're getting closer to achieving your Drive. Add 2 extra Coin to your Hoard."
   },
   {
    "t": "check",
    "key": "hoard-6",
    "text": "Answer: What in town regularly reminds you of your Drive?"
   },
   {
    "t": "check",
    "key": "hoard-7",
    "text": "Answer: How does your appearance reflect your obsession with your Drive?"
   },
   {
    "t": "check",
    "key": "hoard-8",
    "text": "Narrate a flashback showing how you secretly betrayed the party in order to satisfy your Drive. Add 2 extra Coin to your Hoard."
   },
   {
    "t": "check",
    "key": "hoard-9",
    "text": "Optional: Instead of adding Coin to your Hoard, remove any amount you wish (this can be done in order to satisfy Burdens or any other action on this sheet). The GM will narrate a scene showing why you will never satisfy your Drive."
   }
  ]
 },
 {
  "title": "Carousing",
  "blocks": [
   {
    "t": "p",
    "text": "Spend 1 Coin in town to get a piece of useful information (such as a rumor, map, or a named monster's Weakness) before the incursion. Each time you do so, mark the first unmarked option and do as instructed:"
   },
   {
    "t": "check",
    "key": "carousing-0",
    "text": "Ask one player for an adjective, and ask another for a noun. Combine them for the name of your favorite tavern in town."
   },
   {
    "t": "check",
    "key": "carousing-1",
    "text": "Describe the “high quality” meal you order at your favorite tavern. Ask the other players to describe how you have it all wrong, and how the fare at your favorite tavern is substandard."
   },
   {
    "t": "check",
    "key": "carousing-2",
    "text": "Answer: In what ways have you personalized your favorite tavern or otherwise made it feel like a second home?"
   },
   {
    "t": "check",
    "key": "carousing-3",
    "text": "Optional: Spend 3 Coin for an ownership stake in your favorite tavern. You now get two pieces of useful information when you spend 1 Coin there."
   }
  ]
 },
 {
  "title": "Equipment",
  "blocks": [
   {
    "t": "p",
    "text": "Spend 1 Coin in town to open crossed-out slots in your backpack. The first time you do so:"
   },
   {
    "t": "check",
    "key": "equipment-ft-0",
    "text": "Name the shopkeeper and work with the GM to define their secret. The secret can be anything—a magical item they have in their possession, a lucrative opportunity they're aware of, an estranged family member they want to find—so long as it's something you might be interested in. Write the secret on the line below."
   },
   {
    "t": "secret"
   },
   {
    "t": "p",
    "text": "Each time thereafter, mark a box. When all the boxes are marked, the GM will present a side quest related to the shopkeeper's secret."
   },
   {
    "t": "boxes",
    "keys": [
     "equipment-box-0",
     "equipment-box-1",
     "equipment-box-2",
     "equipment-box-3",
     "equipment-box-4"
    ]
   }
  ]
 },
 {
  "title": "Training",
  "blocks": [
   {
    "t": "p",
    "text": "You have a mentor training you in a new Skill. Each Skill you acquire costs 1 Burden. Each time you do so, complete all of the following:"
   },
   {
    "t": "bullet",
    "text": "Name your mentor and describe an incident they are famous for."
   },
   {
    "t": "bullet",
    "text": "Narrate a short montage showing how you learned the Skill after days, weeks, or months of training."
   },
   {
    "t": "bullet",
    "text": "Narrate why your mentor or your new Skill increases your Burdens. Are you taking care of your mentor in some way? Does your Skill require specialized equipment? Something else?"
   }
  ]
 },
 {
  "title": "Library",
  "blocks": [
   {
    "t": "p",
    "text": "You have acquired a few old formulas. Studying them unlocks new Powers, at a cost of 1 Burden per Power. Each time you do so, pick one:"
   },
   {
    "t": "bullet",
    "text": "Narrate a scene showing the moment you mastered the Power."
   },
   {
    "t": "bullet",
    "text": "Describe how mastery of the Power affects your appearance."
   }
  ]
 },
 {
  "title": "Healing",
  "blocks": [
   {
    "t": "p",
    "text": "Spend 1 Coin in town to heal yourself of 1 Ruin. Alternatively, you can mark an item from the list below and do what it says to heal yourself of 1 Ruin. You cannot choose an option that is already marked, and you can only heal 1 Ruin in this way before returning to an incursion."
   },
   {
    "t": "check",
    "key": "healing-0",
    "text": "Narrate a scene showing how you satisfy your physical desires when in town."
   },
   {
    "t": "check",
    "key": "healing-1",
    "text": "Narrate a scene showing a private side of you few others see."
   },
   {
    "t": "check",
    "key": "healing-2",
    "text": "Narrate a scene showing a truly beautiful place in or near town."
   }
  ]
 },
 {
  "title": "Household",
  "blocks": [
   {
    "t": "p",
    "text": "Access to a higher quality of life automatically heals you of 1 Ruin and all Conditions when you return home. When you establish a Household, increase your Burdens by 1, then complete both of the following:"
   },
   {
    "t": "check",
    "key": "household-ft-0",
    "text": "Answer: What kind of structure is your Household? A small cottage? A decrepit temple you are lovingly restoring? A series of tunnels belonging to the local thieves' guild? Something else?"
   },
   {
    "t": "check",
    "key": "household-ft-1",
    "text": "Ask the other players: Which memento from our journeys can be found in my Household? Note the answers on the lines below."
   },
   {
    "t": "p",
    "text": "Each time thereafter you use the Household to clear Conditions or heal Ruin, write down a memento you kept from the incursion."
   },
   {
    "t": "household_list"
   }
  ]
 },
 {
  "title": "Funeral",
  "blocks": [
   {
    "t": "p",
    "text": "If a scavenger is killed on an incursion, any player with a scavenger still alive should describe how their character memorializes their fallen comrade. If the fallen scavenger has a Household, the players of the survivors can take a memento from it and add it to their own Household or Found Equipment."
   }
  ]
 }
];

// Every key that can be marked.
export const HEARTHFIRE_KEYS = new Set(HEARTHFIRE.flatMap(s => s.blocks.flatMap(b => b.t === 'check' ? [b.key] : b.t === 'boxes' ? b.keys : [])));
