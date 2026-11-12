// KittyMart cat data: breeds (name, rarity, facts, art params), zone pools, and a
// small SVG cat generator so every breed has its own cartoon portrait — no photos,
// no network. All art is original and drawn in code.

// ── art helpers ─────────────────────────────────────────────────────────────
const shade = (hex, amt) => {
  const n = parseInt(hex.slice(1), 16);
  const f = v => Math.max(0, Math.min(255, v + amt));
  const h = v => f(v).toString(16).padStart(2, '0');
  return '#' + h(n >> 16) + h((n >> 8) & 255) + h(n & 255);
};
const RAR_BG = { Common: ['#f1faf5', '#cfeede'], Uncommon: ['#eef8ff', '#cde7fb'], Rare: ['#f5eeff', '#dccbf7'], Epic: ['#fff0f6', '#fbcfe2'], Legendary: ['#fff9df', '#ffe08a'] };
const EYES = { gold: '#e8b83a', green: '#5fbf7a', blue: '#5aa9e6', copper: '#d9822b', amber: '#e0a030', hazel: '#a9b04a', odd: '#5aa9e6' };

function catSVG(b, uid) {
  const O = '#6b4430';
  const base = b.c, pat = b.p || 'solid', fl = b.f || 0, ear = b.ear || 'n';
  const white = '#fffaf2';
  const whiteMarks = pat === 'tux' || pat === 'bi' || pat === 'tabbyw';
  const belly = whiteMarks ? white : (b.b || shade(base, 28));
  const pc = b.pc || shade(base, -45), pc2 = b.pc2 || '#34303d';
  const eye = EYES[b.e] || b.e || EYES.gold;
  const hairless = pat === 'hairless';
  const [bg1, bg2] = RAR_BG[b.r] || RAR_BG.Common;
  const pawC = whiteMarks ? white : pat === 'point' ? pc : base;
  const headW = 50 + fl * 3;

  let s = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200"><defs>`;
  s += `<radialGradient id="g${uid}" cx="50%" cy="35%" r="75%"><stop offset="0" stop-color="${bg1}"/><stop offset="1" stop-color="${bg2}"/></radialGradient>`;
  s += `<clipPath id="h${uid}"><ellipse cx="100" cy="98" rx="${headW}" ry="42"/></clipPath>`;
  s += `<clipPath id="b${uid}"><path d="M58 197 C40 170 50 124 100 120 C150 124 160 170 142 197Z"/></clipPath></defs>`;
  s += `<rect width="200" height="200" rx="26" fill="url(#g${uid})"/>`;
  if (b.r === 'Legendary' || b.r === 'Epic') {
    const star = (x, y, r, c) => `<path d="M${x} ${y - r}L${x + r * .28} ${y - r * .28}L${x + r} ${y}L${x + r * .28} ${y + r * .28}L${x} ${y + r}L${x - r * .28} ${y + r * .28}L${x - r} ${y}L${x - r * .28} ${y - r * .28}Z" fill="${c}"/>`;
    s += star(28, 30, 9, '#fff') + star(172, 44, 7, '#fff') + (b.r === 'Legendary' ? star(170, 170, 8, '#ffd24a') + star(30, 168, 6, '#ffd24a') : '');
  }
  // tail
  const tailC = pat === 'point' ? pc : base;
  s += `<path d="M140 190 C176 190 186 150 166 130" fill="none" stroke="${O}" stroke-width="18" stroke-linecap="round"/>`;
  s += `<path d="M140 190 C176 190 186 150 166 130" fill="none" stroke="${tailC}" stroke-width="12.5" stroke-linecap="round"/>`;
  if (pat === 'tabby' || pat === 'tabbyw' || pat === 'spots' || pat === 'ticked') s += `<path d="M140 190 C176 190 186 150 166 130" fill="none" stroke="${pc}" stroke-width="12.5" stroke-linecap="butt" stroke-dasharray="4 8"/>`;
  if (pat === 'tuxtail') s += '';
  // body
  s += `<path d="M58 197 C40 170 50 124 100 120 C150 124 160 170 142 197Z" fill="${base}" stroke="${O}" stroke-width="3" stroke-linejoin="round"/>`;
  s += `<g clip-path="url(#b${uid})">`;
  if (pat === 'tabby' || pat === 'tabbyw' || pat === 'ticked') for (let i = 0; i < 4; i++) s += `<path d="M44 ${140 + i * 13} L66 ${144 + i * 13} M156 ${140 + i * 13} L134 ${144 + i * 13}" stroke="${pc}" stroke-width="4.5" stroke-linecap="round"/>`;
  if (pat === 'spots') [[66, 150], [78, 176], [134, 152], [122, 178], [96, 190]].forEach(([x, y]) => { s += `<circle cx="${x}" cy="${y}" r="4.5" fill="${pc}"/>`; });
  if (pat === 'calico') s += `<ellipse cx="62" cy="158" rx="16" ry="20" fill="${pc}"/><ellipse cx="140" cy="176" rx="14" ry="16" fill="${pc2}"/>`;
  if (pat === 'tortie') s += `<ellipse cx="64" cy="160" rx="15" ry="19" fill="${pc}"/><ellipse cx="138" cy="170" rx="13" ry="18" fill="${pc2}"/><ellipse cx="100" cy="190" rx="10" ry="7" fill="${pc}"/>`;
  if (pat === 'bi') s += `<ellipse cx="100" cy="168" rx="46" ry="34" fill="${white}"/>`;
  if (pat === 'stars') [[70, 150], [128, 160], [96, 182], [84, 134], [142, 140]].forEach(([x, y]) => { s += `<circle cx="${x}" cy="${y}" r="2.4" fill="${pc}"/>`; });
  s += `</g>`;
  s += `<ellipse cx="100" cy="168" rx="${whiteMarks ? 20 : 21}" ry="27" fill="${belly}" opacity="${whiteMarks ? 1 : .85}"/>`;
  if (hairless) s += `<path d="M64 150 Q80 158 70 176 M136 150 Q120 158 130 176" fill="none" stroke="${shade(base, -30)}" stroke-width="2" stroke-linecap="round"/>`;
  if (fl >= 2) s += `<path d="M66 130 L56 150 L74 142 L82 158 L100 146 L118 158 L126 142 L144 150 L134 130Z" fill="${belly}" stroke="${O}" stroke-width="2.4" stroke-linejoin="round"/>`;
  // paws
  s += `<ellipse cx="82" cy="193" rx="14" ry="8" fill="${pawC}" stroke="${O}" stroke-width="2.6"/><ellipse cx="118" cy="193" rx="14" ry="8" fill="${pawC}" stroke="${O}" stroke-width="2.6"/>`;
  s += `<path d="M78 192v-3M83 192v-3M113 192v-3M118 192v-3" stroke="${O}" stroke-width="1.4" stroke-linecap="round" opacity=".6"/>`;
  // cheek fluff
  if (fl >= 1) {
    s += `<path d="M52 88 L38 94 L50 99 L36 108 L52 112Z" fill="${base}" stroke="${O}" stroke-width="2.4" stroke-linejoin="round"/>`;
    s += `<path d="M148 88 L162 94 L150 99 L164 108 L148 112Z" fill="${base}" stroke="${O}" stroke-width="2.4" stroke-linejoin="round"/>`;
  }
  // ears
  const earOuter = pat === 'point' ? pc : base;
  const earL = ear === 'fold' ? 'M58 82 L56 56 Q70 52 86 64Z' : ear === 'curl' ? 'M58 80 Q34 56 48 38 Q72 44 88 62Z' : ear === 'big' ? 'M54 82 L38 26 L90 60Z' : 'M58 80 L52 38 L88 62Z';
  const earR = ear === 'fold' ? 'M142 82 L144 56 Q130 52 114 64Z' : ear === 'curl' ? 'M142 80 Q166 56 152 38 Q128 44 112 62Z' : ear === 'big' ? 'M146 82 L162 26 L110 60Z' : 'M142 80 L148 38 L112 62Z';
  s += `<path d="${earL}" fill="${earOuter}" stroke="${O}" stroke-width="3" stroke-linejoin="round"/><path d="${earR}" fill="${earOuter}" stroke="${O}" stroke-width="3" stroke-linejoin="round"/>`;
  if (ear !== 'fold') {
    s += ear === 'big'
      ? `<path d="M58 74 L46 38 L80 60Z" fill="#f7a8b8"/><path d="M142 74 L154 38 L120 60Z" fill="#f7a8b8"/>`
      : ear === 'curl'
        ? `<path d="M62 72 Q46 54 53 44 Q68 50 80 62Z" fill="#f7a8b8"/><path d="M138 72 Q154 54 147 44 Q132 50 120 62Z" fill="#f7a8b8"/>`
        : `<path d="M62 70 L57 46 L80 62Z" fill="#f7a8b8"/><path d="M138 70 L143 46 L120 62Z" fill="#f7a8b8"/>`;
  }
  // head
  s += `<ellipse cx="100" cy="98" rx="${headW}" ry="42" fill="${base}" stroke="${O}" stroke-width="3"/>`;
  s += `<g clip-path="url(#h${uid})">`;
  if (pat === 'tabby' || pat === 'tabbyw' || pat === 'ticked') {
    s += `<path d="M100 56 L100 72 M86 58 L89 72 M114 58 L111 72 M48 94 L66 97 M48 106 L66 104 M152 94 L134 97 M152 106 L134 104" stroke="${pc}" stroke-width="4.2" stroke-linecap="round"/>`;
  }
  if (pat === 'tux') s += `<path d="M100 54 L88 104 L112 104Z" fill="${white}"/>`;
  if (whiteMarks) s += `<ellipse cx="100" cy="122" rx="26" ry="19" fill="${white}"/>`;
  if (pat === 'bi') s += `<path d="M112 54 L150 70 L150 110 L110 100Z" fill="${white}"/>`;
  if (pat === 'calico') s += `<ellipse cx="66" cy="76" rx="26" ry="20" fill="${pc}"/><ellipse cx="136" cy="74" rx="22" ry="17" fill="${pc2}"/>`;
  if (pat === 'tortie') s += `<ellipse cx="66" cy="78" rx="24" ry="20" fill="${pc}"/><ellipse cx="138" cy="84" rx="20" ry="18" fill="${pc2}"/><path d="M100 54 L92 76 L108 76Z" fill="${pc}"/>`;
  if (pat === 'point') s += `<ellipse cx="100" cy="114" rx="30" ry="24" fill="${pc}" opacity=".95"/><path d="M100 54 L90 80 L110 80Z" fill="${pc}" opacity=".5"/>`;
  if (pat === 'spots') [[72, 80], [128, 80], [100, 62], [56, 100], [144, 100]].forEach(([x, y]) => { s += `<circle cx="${x}" cy="${y}" r="4" fill="${pc}"/>`; });
  if (pat === 'stars') [[70, 78], [130, 76], [100, 62], [58, 100], [146, 102]].forEach(([x, y]) => { s += `<circle cx="${x}" cy="${y}" r="2.6" fill="${pc}"/>`; });
  if (hairless) s += `<path d="M82 62 Q100 56 118 62 M86 70 Q100 65 114 70" fill="none" stroke="${shade(base, -34)}" stroke-width="2" stroke-linecap="round"/>`;
  if (b.mask) s += `<ellipse cx="100" cy="112" rx="30" ry="24" fill="${b.mask}" opacity=".9"/>`;
  s += `</g>`;
  // face
  const eyeX = [78, 122];
  eyeX.forEach((x, i) => {
    const ec = b.e === 'odd' && i === 1 ? '#e8b83a' : eye;
    s += `<ellipse cx="${x}" cy="97" rx="11.5" ry="13.5" fill="${ec}" stroke="#3a2418" stroke-width="2.6"/>`;
    s += `<ellipse cx="${x}" cy="98" rx="6.4" ry="10.6" fill="#2b1b14"/>`;
    s += `<circle cx="${x + 4}" cy="91" r="4" fill="#fff"/><circle cx="${x - 4}" cy="104" r="2" fill="#fff"/>`;
  });
  s += `<ellipse cx="62" cy="116" rx="9" ry="5" fill="#ff8fa8" opacity=".5"/><ellipse cx="138" cy="116" rx="9" ry="5" fill="#ff8fa8" opacity=".5"/>`;
  s += `<path d="M95 112 L105 112 L100 118.5Z" fill="#f08a9e" stroke="#b25a6c" stroke-width="1" stroke-linejoin="round"/>`;
  s += `<path d="M100 118.5 Q100 126 92 126 M100 118.5 Q100 126 108 126" fill="none" stroke="${O}" stroke-width="2.2" stroke-linecap="round"/>`;
  s += `<path d="M64 117 L36 110 M64 122 L36 125 M136 117 L164 110 M136 122 L164 125" stroke="#8a6a58" stroke-width="1.6" stroke-linecap="round" opacity=".75"/>`;
  s += `</svg>`;
  return s;
}

const artCache = {};
let artUid = 0;
export function catArtUrl(name) {
  if (artCache[name]) return artCache[name];
  const br = BREEDS_BY_NAME[name];
  if (!br) return null;
  const url = 'data:image/svg+xml;utf8,' + encodeURIComponent(catSVG({ ...br.art, r: br.rarity }, ++artUid));
  artCache[name] = url;
  return url;
}
export const isGeneratedArt = url => typeof url === 'string' && url.startsWith('data:image/svg+xml');

// ── breed table ──────────────────────────────────────────────────────────────
// art: c base colour, b belly, p pattern, pc/pc2 pattern colours, e eye colour key,
//      f fluff 0-2, ear n|fold|curl|big, mask extra face colour
const B = (name, rarity, facts, art) => ({ name, rarity, facts, art });
const GINGER = '#f0a04b', STRIPE = '#c06a28', CREAM = '#f6e3c0', WHITE = '#fbf7f0', GREY = '#9aa1b0', BLACK = '#37333f', BROWN = '#8d5d3d', CHOC = '#6c4b3b', SILVER = '#cdd2dc', FAWN = '#d9b88f', BLUE = '#8793a8';

export const CAT_BREEDS = [
  // ── Legendary ──
  B('Maine Coon', 'Legendary', ['One of the largest domesticated cat breeds!', 'Famous for tufted ears, a bushy tail and chirpy trills.', 'Often called the gentle giant of the cat world.'], { c: BROWN, p: 'tabby', pc: '#5b3a24', e: 'gold', f: 2, ear: 'big' }),
  B('Bengal', 'Legendary', ['Bred from domestic cats crossed with the wild Asian leopard cat.', 'A glittering coat with leopard-like rosettes.', 'Many Bengals love playing with water!'], { c: '#e4a84a', p: 'spots', pc: '#7a4a1e', e: 'green', f: 0 }),
  B('Savannah', 'Legendary', ['A hybrid of a domestic cat and the African serval.', 'One of the tallest domestic cat breeds.', 'Famous for huge ears and amazing leaps.'], { c: '#dcb06a', p: 'spots', pc: '#3c2a1c', e: 'gold', ear: 'big' }),
  B('Sphynx', 'Legendary', ['Almost hairless — and warm to the touch!', 'Needs regular baths because skin oils build up.', 'Wrinkly, affectionate and loves to cuddle.'], { c: '#e8c3b0', b: '#f2d6c6', p: 'hairless', e: 'green', ear: 'big' }),
  B('Norwegian Forest Cat', 'Legendary', ['Legend says Viking ships carried them as mouser cats.', 'A thick, water-resistant double coat for cold winters.', 'Excellent climbers with strong claws.'], { c: '#7c6a58', p: 'tabbyw', pc: '#3f3226', e: 'green', f: 2 }),
  B('Siberian', 'Legendary', ['A natural breed from the forests of Russia.', 'Has a thick triple coat for freezing weather.', 'Famous for jumping skills and dog-like friendliness.'], { c: '#b48a62', p: 'tabby', pc: '#6a4a30', e: 'gold', f: 2 }),
  B('Turkish Van', 'Legendary', ['Nicknamed the swimming cat — it loves water!', 'White body with coloured markings on head and tail.', 'An ancient breed from the Lake Van region of Turkey.'], { c: WHITE, p: 'tortie', pc: '#d8873f', pc2: '#d8873f', e: 'odd', f: 1 }),
  B('Egyptian Mau', 'Legendary', ['One of the fastest domestic cats — around 48 km/h!', 'Naturally spotted, which is rare for domestic cats.', 'Thought to resemble cats in ancient Egyptian art.'], { c: SILVER, p: 'spots', pc: '#4a4658', e: 'green' }),

  // ── Epic ──
  B('Ragdoll', 'Epic', ['Known for going floppy and relaxed when cuddled.', 'Big sapphire-blue eyes and a silky coat.', 'Often follows its people from room to room.'], { c: '#efe3d2', p: 'point', pc: '#8a6a58', e: 'blue', f: 2 }),
  B('Persian', 'Epic', ['One of the oldest cat breeds in the world.', 'A long, luxurious coat that needs daily brushing.', 'Known for a calm, sweet nature and a flat face.'], { c: '#f3ede2', p: 'solid', e: 'copper', f: 2 }),
  B('British Shorthair', 'Epic', ['Round face, round eyes, thick plush coat.', 'Often said to have inspired the Cheshire Cat.', 'Calm and easygoing — a great lap companion.'], { c: BLUE, p: 'solid', e: 'copper', f: 1 }),
  B('Russian Blue', 'Epic', ['A shimmering silvery-blue coat and vivid green eyes.', 'Reserved with strangers but loyal to family.', 'Their coat has a plush double layer.'], { c: '#8f9bb0', p: 'solid', e: 'green' }),
  B('Siamese', 'Epic', ['Striking blue eyes and darker face, ears, paws and tail.', 'Very talkative — they love to chat!', 'The pointed pattern is linked to body temperature.'], { c: '#f1e2c6', p: 'point', pc: '#6b4a3a', e: 'blue', ear: 'big' }),
  B('Abyssinian', 'Epic', ['A ticked coat where each hair has bands of colour.', 'Active, curious and a great climber.', 'Looks like cats in ancient paintings.'], { c: '#c8803f', p: 'ticked', pc: '#8a4f22', e: 'gold', ear: 'big' }),
  B('Birman', 'Epic', ['Famous for four white "gloves" on its paws.', 'Legend says they were temple cats in Burma.', 'Gentle and sociable with blue eyes.'], { c: '#f0e3cf', p: 'point', pc: '#7d6350', e: 'blue', f: 1, ear: 'n' }),
  B('Scottish Fold', 'Epic', ['A gene makes its ears fold forward and down.', 'Born with straight ears that fold at a few weeks old.', 'Round face and a sweet, owl-like look.'], { c: '#b7bcc8', p: 'tabby', pc: '#7c8394', e: 'gold', ear: 'fold', f: 1 }),
  B('Oriental Shorthair', 'Epic', ['Enormous ears and a slender, elegant body.', 'Comes in hundreds of colours and patterns.', 'Chatty and very people-loving.'], { c: CHOC, p: 'solid', e: 'green', ear: 'big' }),
  B('Burmese', 'Epic', ['A silky, satin-like short coat.', 'Heavier than it looks — "a brick wrapped in silk".', 'Very affectionate and loves attention.'], { c: '#7a5a48', p: 'solid', e: 'gold' }),
  B('Turkish Angora', 'Epic', ['A graceful, silky coat often seen in white.', 'An ancient breed linked to the city of Ankara.', 'Playful and energetic.'], { c: '#fbf7f0', p: 'solid', e: 'odd', f: 1 }),
  B('Devon Rex', 'Epic', ['A pixie face with big ears and a curly coat.', 'Often called a monkey in a cat suit.', 'Loves to perch on shoulders.'], { c: '#9b8f86', p: 'tabbyw', pc: '#5e544c', e: 'green', ear: 'big' }),

  // ── Rare ──
  B('Cornish Rex', 'Rare', ['A soft, wavy coat with no guard hairs.', 'Slender body with big ears.', 'Very playful and energetic.'], { c: '#e9d6bf', p: 'solid', e: 'gold', ear: 'big' }),
  B('American Curl', 'Rare', ['Ears that curl backwards in a graceful arc.', 'Kittens are born with straight ears.', 'Often called the Peter Pan of cats — they stay playful.'], { c: '#d6a773', p: 'tabby', pc: '#8c5c34', e: 'gold', ear: 'curl' }),
  B('Himalayan', 'Rare', ['A Persian-type cat with Siamese colourpoint markings.', 'Long, silky coat that needs daily care.', 'Calm, gentle and sweet.'], { c: '#f3e7d3', p: 'point', pc: '#6c5444', e: 'blue', f: 2 }),
  B('Exotic Shorthair', 'Rare', ['Like a Persian but with a short plush coat.', 'Flat face and round, teddy-bear look.', 'Often called the lazy cat lover\'s Persian.'], { c: '#e9c79a', p: 'tabby', pc: '#bf8a50', e: 'copper', f: 1 }),
  B('Tonkinese', 'Rare', ['A cross between Siamese and Burmese cats.', 'Aqua-coloured eyes are a signature.', 'Outgoing, chatty and playful.'], { c: '#b79a84', p: 'point', pc: '#5b4636', e: '#7fc9bf' }),
  B('Balinese', 'Rare', ['Basically a long-haired Siamese.', 'A feathery plume of a tail.', 'Loves to talk and play.'], { c: '#f4e8d2', p: 'point', pc: '#6e5a4c', e: 'blue', f: 1 }),
  B('Ocicat', 'Rare', ['Spotted like a wild ocelot — but fully domestic!', 'Named after the ocelot, with no wild blood.', 'Social and often learns tricks.'], { c: '#d9b07a', p: 'spots', pc: '#7a4e2a', e: 'gold' }),
  B('Manx', 'Rare', ['Famous for having no tail (or just a tiny one)!', 'Originally from the Isle of Man.', 'Strong back legs make them great jumpers.'], { c: '#d49455', p: 'tabby', pc: '#8a5222', e: 'copper' }),
  B('Japanese Bobtail', 'Rare', ['A short, pom-pom tail like a bunny.', 'In Japan, Maneki-neko lucky cats are often modelled on them.', 'Known for being smart and chatty.'], { c: WHITE, p: 'calico', pc: '#e48a3e', pc2: '#34303d', e: 'gold' }),
  B('Chartreux', 'Rare', ['A blue-grey coat with glowing copper eyes.', 'Known for a sweet "smiling" face.', 'Quiet and gentle with a woolly coat.'], { c: '#7d8aa0', p: 'solid', e: 'copper', f: 1 }),
  B('Somali', 'Rare', ['Basically a long-haired Abyssinian.', 'A big bushy fox-like tail.', 'Playful and adores climbing.'], { c: '#c47a3a', p: 'ticked', pc: '#7a4420', e: 'gold', ear: 'big', f: 1 }),
  B('Singapura', 'Rare', ['One of the smallest cat breeds in the world.', 'Huge eyes and a warm sepia-ticked coat.', 'Curious and loves high places.'], { c: '#d3b38a', p: 'ticked', pc: '#8a6a44', e: 'green' }),
  B('Korat', 'Rare', ['A silver-tipped blue coat and heart-shaped face.', 'In Thailand they are considered symbols of good luck.', 'Gentle and loving with bright green eyes.'], { c: '#98a3b8', p: 'solid', e: 'green' }),
  B('Munchkin', 'Rare', ['Famous for adorable short legs!', 'Can run and play just like other cats.', 'Friendly and curious.'], { c: '#d9a368', p: 'tabbyw', pc: '#9a6532', e: 'gold' }),
  B('LaPerm', 'Rare', ['Soft curly ringlets all over.', 'Kittens may be born bald and grow curls later.', 'Affectionate and loves laps.'], { c: '#cf8b4a', p: 'tabby', pc: '#8c5426', e: 'gold', f: 1 }),
  B('Selkirk Rex', 'Rare', ['A plush, curly coat like a teddy bear.', 'Even the whiskers curl!', 'Calm, patient and easygoing.'], { c: '#c9c1d0', p: 'solid', e: 'gold', f: 1 }),
  B('Australian Mist', 'Rare', ['The first cat breed developed in Australia.', 'A speckled "misty" coat in soft colours.', 'Friendly and happy to stay indoors.'], { c: '#d8c7a8', p: 'spots', pc: '#b49a74', e: 'gold' }),

  // ── Uncommon ──
  B('Calico', 'Uncommon', ['Almost always female — males are very rare.', 'A patchwork of white, orange and black.', 'Considered good luck in many cultures.'], { c: WHITE, p: 'calico', pc: '#e48a3e', pc2: '#34303d', e: 'gold' }),
  B('Tortoiseshell', 'Uncommon', ['A swirl of black and orange, like tortoiseshell.', 'People talk about "tortitude" — lots of sass!', 'Almost always female.'], { c: '#3b3340', p: 'tortie', pc: '#e0803a', pc2: '#b85a2c', e: 'amber' }),
  B('Tuxedo Cat', 'Uncommon', ['Black and white like a tiny formal suit.', 'Not a breed — it is a coat pattern.', 'Famous tuxedo cats have even been in the news.'], { c: BLACK, p: 'tux', e: 'green' }),
  B('Snowshoe', 'Uncommon', ['White paws look like little snowshoes.', 'Blue eyes and Siamese-style points.', 'Smart, social and loves water.'], { c: '#e7dac4', p: 'point', pc: '#7e6a5a', e: 'blue' }),
  B('Havana Brown', 'Uncommon', ['A rich chocolate-brown coat and green eyes.', 'Rare and valued for its bright whiskers.', 'Loves to touch things with its paws.'], { c: '#6a4a3a', p: 'solid', e: 'green' }),
  B('Nebelung', 'Uncommon', ['Name means "creature of the mist" in German.', 'A long-haired Russian Blue look.', 'Shy at first but very loyal.'], { c: '#8c98ae', p: 'solid', e: 'green', f: 2 }),
  B('American Wirehair', 'Uncommon', ['A crimped, wiry coat — very rare!', 'The first one appeared in New York in 1966.', 'A relaxed and easygoing cat.'], { c: '#c8a06a', p: 'tabby', pc: '#8c6034', e: 'gold', f: 1 }),
  B('Burmilla', 'Uncommon', ['Started by an accidental Burmese–Chinchilla Persian pairing.', 'A shimmering silvery coat with dark outlined eyes.', 'Playful and affectionate.'], { c: '#d9d4dc', p: 'ticked', pc: '#9e94a6', e: 'green' }),
  B('Pixie-bob', 'Uncommon', ['A wild look with a short bobbed tail.', 'Often has extra toes (polydactyl).', 'Loyal and dog-like.'], { c: '#b99669', p: 'spots', pc: '#6a4a2c', e: 'gold', f: 1 }),
  B('Toyger', 'Uncommon', ['Bred to look like a toy tiger!', 'Bold stripes on a bright orange coat.', 'Friendly and trainable.'], { c: '#e28a3c', p: 'tabby', pc: '#7a3c14', e: 'gold' }),
  B('Bombay', 'Uncommon', ['A mini black panther with golden eyes.', 'Sleek, glossy black coat.', 'Loves attention and laps.'], { c: '#2c2933', p: 'solid', e: 'copper' }),
  B('Cymric', 'Uncommon', ['The long-haired version of the Manx.', 'A round, fluffy look with a rounded rump.', 'Great jumpers with strong hind legs.'], { c: '#c68a52', p: 'tabbyw', pc: '#845022', e: 'gold', f: 2 }),
  B('Lykoi', 'Uncommon', ['Called the werewolf cat for its patchy coat!', 'Its roan coat is a natural mutation.', 'Surprisingly friendly with its people.'], { c: '#6e6a74', p: 'ticked', pc: '#3a3640', e: 'gold', f: 0 }),
  B('Seal Point', 'Uncommon', ['Cream body with deep brown "seal" points.', 'Bright blue eyes are typical.', 'Colour darkens in cooler parts of the body.'], { c: '#f0e0c4', p: 'point', pc: '#5a4030', e: 'blue' }),

  // ── Common ──
  B('Domestic Shorthair', 'Common', ['The most common type of cat in the world.', 'Comes in every colour and pattern.', 'Healthy, friendly and adaptable.'], { c: '#a79a8c', p: 'tabby', pc: '#6d6054', e: 'green' }),
  B('Domestic Longhair', 'Common', ['A fluffy mixed-breed cat with a long coat.', 'Needs regular brushing.', 'Often an affectionate lap cat.'], { c: '#cdb497', p: 'tabbyw', pc: '#8c7452', e: 'gold', f: 2 }),
  B('Ginger Tabby', 'Common', ['Most orange cats are boys!', 'The "M" on the forehead is a tabby signature.', 'Often very friendly and food-motivated.'], { c: GINGER, p: 'tabby', pc: STRIPE, e: 'gold' }),
  B('Grey Tabby', 'Common', ['Tabby stripes in shades of grey.', 'Tabby is a pattern, not a breed.', 'One of the most common coat looks.'], { c: GREY, p: 'tabby', pc: '#646c7c', e: 'gold' }),
  B('Brown Tabby', 'Common', ['The classic wildcat-style coat.', 'Stripes help it blend into the shadows.', 'Common in alleys and homes alike.'], { c: '#9a7048', p: 'tabby', pc: '#4a3320', e: 'green' }),
  B('Black Cat', 'Common', ['In the UK and Japan, black cats are seen as lucky.', 'Sunlight can make a black coat look rusty-brown.', 'Sleek and mysterious.'], { c: '#34303c', p: 'solid', e: 'amber' }),
  B('White Cat', 'Common', ['White cats can have blue, gold or odd-coloured eyes.', 'Pure white coats show every speck of dust!', 'Beautiful and elegant.'], { c: '#fbf7f0', p: 'solid', e: 'blue' }),
  B('Cream Cat', 'Common', ['A pale, soft orange called cream.', 'A gentle, sandy-coloured coat.', 'Often laid-back and cuddly.'], { c: '#f2d9ae', p: 'solid', e: 'gold' }),
  B('Silver Tabby', 'Common', ['A shimmering silver coat with bold stripes.', 'Often has pretty green or hazel eyes.', 'Looks like a tiny glittering tiger.'], { c: SILVER, p: 'tabby', pc: '#7a8190', e: 'green' }),
  B('Black & White Cat', 'Common', ['A bicolour coat with big white patches.', 'No two coats look alike.', 'Often outgoing and playful.'], { c: '#3a3640', p: 'bi', e: 'gold' }),
  B('Grey & White Cat', 'Common', ['Soft grey with a white chest and paws.', 'A very popular coat colour.', 'Usually friendly and easygoing.'], { c: '#a4abb8', p: 'bi', e: 'gold' }),
  B('Ginger & White Cat', 'Common', ['Orange patches with a clean white bib.', 'Often called a marmalade-and-cream cat.', 'Known for being goofy and affectionate.'], { c: '#ef9f4a', p: 'bi', e: 'gold' }),
  B('Tabby & White Cat', 'Common', ['Tabby stripes with white socks and bib.', 'Great at camouflage — except the white socks!', 'Playful all through life.'], { c: '#a98863', p: 'tabbyw', pc: '#5f4630', e: 'green' }),
  B('Fawn Cat', 'Common', ['A warm, sandy fawn-coloured coat.', 'Soft pinkish-beige nose and paws.', 'Gentle and relaxed.'], { c: FAWN, p: 'solid', e: 'green' }),
];

const BREEDS_BY_NAME = {};
CAT_BREEDS.forEach(b => {
  BREEDS_BY_NAME[b.name] = b;
  // `api` doubles as the default photo for a freshly caught cat: a generated cartoon portrait.
  Object.defineProperty(b, 'api', { enumerable: true, get() { return catArtUrl(b.name); } });
  b.fallback = null;
});

// Catch-zone pools (names must match CAT_BREEDS above)
export const ZONE_BREEDS = {
  home:        ['Domestic Shorthair', 'Ginger Tabby', 'Grey Tabby', 'Black Cat', 'White Cat', 'Tuxedo Cat', 'Calico', 'Brown Tabby', 'Black & White Cat', 'British Shorthair', 'Ragdoll', 'Maine Coon', 'Bengal', 'Tortoiseshell', 'Cream Cat', 'Snowshoe'],
  park:        ['Abyssinian', 'Bengal', 'Ocicat', 'Egyptian Mau', 'Domestic Shorthair', 'Ginger Tabby', 'Grey & White Cat', 'Tabby & White Cat', 'Siberian', 'Somali', 'Toyger', 'Pixie-bob', 'Savannah', 'Silver Tabby', 'Brown Tabby', 'Black Cat'],
  beach:       ['Turkish Van', 'Bengal', 'Maine Coon', 'Domestic Shorthair', 'Ginger & White Cat', 'Cream Cat', 'Fawn Cat', 'Singapura', 'Japanese Bobtail', 'Manx', 'Tuxedo Cat', 'Black & White Cat', 'Silver Tabby', 'Savannah'],
  city:        ['Siamese', 'Russian Blue', 'Scottish Fold', 'Sphynx', 'Burmese', 'Oriental Shorthair', 'Devon Rex', 'Cornish Rex', 'Black Cat', 'Tuxedo Cat', 'Domestic Shorthair', 'Grey Tabby', 'Bombay', 'Chartreux', 'Korat', 'Lykoi'],
  countryside: ['Norwegian Forest Cat', 'Maine Coon', 'Siberian', 'Manx', 'Cymric', 'American Wirehair', 'Brown Tabby', 'Domestic Longhair', 'Domestic Shorthair', 'Ginger Tabby', 'Black & White Cat', 'Pixie-bob', 'Lykoi', 'Turkish Angora', 'Tabby & White Cat'],
  shopping:    ['Persian', 'Himalayan', 'Exotic Shorthair', 'Ragdoll', 'Birman', 'Balinese', 'Burmilla', 'Nebelung', 'Munchkin', 'LaPerm', 'Selkirk Rex', 'American Curl', 'Tonkinese', 'Havana Brown', 'Turkish Angora', 'Scottish Fold'],
  aussie:      ['Australian Mist', 'Domestic Shorthair', 'Ginger Tabby', 'Tuxedo Cat', 'Calico', 'Black Cat', 'Tabby & White Cat', 'Burmese', 'Bengal', 'Ragdoll', 'Seal Point', 'Maine Coon'],
};

export const CAT_TRAITS = [
  '🧶 Yarn Obsessed', '💤 Nap Champion', '🌈 Total Goofball', '🐟 Treat Fiend', '🏃 Zoomie Queen',
  '🐾 Velcro Cat', '🐿️ Window Alarm', '🎭 Drama Kitten', '🛁 Bath Hater', '🎵 Purr Singer',
  '💪 Gym Cat', '🌿 Catnip Roller', '📸 Camera Shy', '🤗 Snuggle Expert', '🕵️ Nose Detective',
  '🦊 Sneaky Stealer', '🎪 Show Off', '😴 Couch Potato', '🏊 Water Lover', '🐦 Bird Watcher',
  '📦 Box Collector', '🧸 Toy Hoarder', '🔔 Doorbell Detective', '🌙 Night Owl', '☀️ Morning Kitten',
];
export const CAT_NAMES_MALE = [
  'Oliver', 'Leo', 'Milo', 'Simba', 'Tigger', 'Felix', 'Oscar', 'Jasper', 'Max', 'Charlie',
  'Loki', 'Smokey', 'Garfield', 'Ziggy', 'Mittens', 'Bandit', 'Shadow', 'Salem', 'Tom', 'Biscuit',
  'Whiskers', 'Cosmo', 'Thor', 'Gizmo', 'Mochi', 'Sushi', 'Toby', 'Rusty', 'Finn', 'Pumpkin',
  'Pepper', 'Merlin', 'Ollie', 'Archie', 'Murphy', 'Sooty', 'Midnight', 'Tiger', 'Moose', 'Ash',
];
export const CAT_NAMES_FEMALE = [
  'Luna', 'Bella', 'Lily', 'Nala', 'Cleo', 'Daisy', 'Willow', 'Coco', 'Misty', 'Ginger',
  'Pearl', 'Princess', 'Molly', 'Sophie', 'Chloe', 'Tilly', 'Poppy', 'Olive', 'Ruby', 'Zoe',
  'Maple', 'Stella', 'Hazel', 'Peaches', 'Duchess', 'Fluffy', 'Callie', 'Honey', 'Mabel', 'Nova',
  'Juno', 'Ivy', 'Pixie', 'Kiki', 'Smudge', 'Marmalade', 'Biscotti', 'Dot', 'Penny', 'Tabitha',
];
