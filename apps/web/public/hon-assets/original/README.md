# HON Original Asset Recovery Library

> **Asset-only handoff.** These are byte-for-byte recovery copies of currently traceable approved original assets. They are not a new visual design, active application mapping, or permission to overwrite protected assets.

## How to reuse without Manus hosting

All exported files are repository-local under `apps/web/public/hon-assets/original/` and can be served by Next.js from the matching `/hon-assets/original/...` path. Before changing an active image reference, obtain owner approval and update the protected mapping in a focused visual review; this recovery branch deliberately changes no application source.

- **Recovered hosted originals:** 27 WebP files
- **Hosted sources that cannot be exported as original artwork:** 4
- **Existing local original portraits already in GitHub:** 8
- **HQ executive portrait originals:** not located; see the blocker below.

## Exported assets

| Export path | Character / concept | Style / role | Format | Dimensions | SHA-256 |
| --- | --- | --- | --- | ---: | --- |
| `hon-assets/original/hq-concepts/hon-core-expanded-concept.webp` | HON Core expanded | approved concept-only HQ visual frame | WebP | 1920 × 1080 | `6657774022db74e4e20602cdc25182cc38e10fb766648ba7a3a4264eb1429899` |
| `hon-assets/original/hq-concepts/hon-core-mobile-fallback-concept.webp` | HON Core mobile fallback | approved concept-only HQ visual frame | WebP | 1080 × 1920 | `4eb1a93b83b2a088a385ab08cd4d8415ded273a7f51f35b3ead48ffb991805d1` |
| `hon-assets/original/hq-concepts/hq-executive-team-concept.webp` | HQ Executive Team | approved concept-only HQ visual frame, not portraits | WebP | 1920 × 1080 | `0aeea11d96b2cc0eaac6122cf5d5c3d8e181b6e42a64c311b3e6b3183ab80416` |
| `hon-assets/original/hq-concepts/hq-mobile-concept.webp` | HQ mobile | approved concept-only HQ visual frame | WebP | 1080 × 1920 | `1624e03b43433eb81a50d5db960bfffe8c43f1318592972dc400c0cc61a0c0fa` |
| `hon-assets/original/hq-concepts/hq-overview-dark.webp` | HQ overview — dark | approved concept-only HQ visual frame | WebP | 1920 × 1080 | `af32318114824e77d286149ab8d6159693f1d61ef7e483ceca4f12f7ad6a9ad2` |
| `hon-assets/original/hq-concepts/hq-overview-light.webp` | HQ overview — light | approved concept-only HQ visual frame | WebP | 1920 × 1080 | `f8caae48ffdd90138b814924f9fe0ea84ded24f48f2fa9147befa47dfa404fd9` |
| `hon-assets/original/hq-concepts/hq-school-detail-concept.webp` | HQ school detail | approved concept-only HQ visual frame | WebP | 1920 × 1080 | `e4c3e04b5de7590f26c4d4c2757fb2809bef49d1ef4968cd32e93d28a27ff093` |
| `hon-assets/original/hq-concepts/hq-school-directory-concept.webp` | School management directory | approved concept-only HQ visual frame | WebP | 1920 × 1080 | `05b0484d9f7d5588c17b251ad85fa03ee1d951f715d0a13e6f785b2a7d2e4e1c` |
| `hon-assets/original/logos/hon-mark.webp` | HON mark / assistant orb identity | approved HON application mark | WebP | 1920 × 1920 | `ebe4de9a5733119faca0fc078bc8ea5dc2ed41efe67ab847ecce24cbbd0e7c23` |
| `hon-assets/original/logos/hon-platform-logo.webp` | HON platform logo | approved durable platform branding | WebP | 1920 × 1920 | `ebe4de9a5733119faca0fc078bc8ea5dc2ed41efe67ab847ecce24cbbd0e7c23` |
| `hon-assets/original/school-ai/anime/alex.webp` | Alex | Modern Anime approved school AI portrait | WebP | 1920 × 1920 | `2a666c796f4b294e9ba6143456ae849636b97d7d654aa8bb2a5903818a6e3c3f` |
| `hon-assets/original/school-ai/anime/chad.webp` | Chad | Modern Anime approved school AI portrait | WebP | 1920 × 1920 | `82f318d42e55717c8d4fcfa1c4568cc1d2f19c911f6b28a778067141f4a910a8` |
| `hon-assets/original/school-ai/anime/maya.webp` | Maya | Modern Anime approved school AI portrait | WebP | 1920 × 1920 | `17a1e591776deabe53e0076d4195c200970b6d55ac706f2b1122c47daecb4da8` |
| `hon-assets/original/school-ai/chibi/alex.webp` | Alex | Chibi approved school AI portrait | WebP | 1920 × 1920 | `4c11e95b2f42f71c8921dcd321793be21b513e60d8b1d6b9f2740c011c626fc0` |
| `hon-assets/original/school-ai/chibi/chad.webp` | Chad | Chibi approved school AI portrait | WebP | 1920 × 1920 | `1b8a44883c2544da71b6d2d98978084b4a2f92afdddf1928892f0b59ab36e673` |
| `hon-assets/original/school-ai/chibi/claire.webp` | Claire | Chibi approved school AI portrait | WebP | 1920 × 1920 | `8c3f805abedf7b53fe1a1c51be0a0ad96d1afaeaf33de1e00e29d007c10c5ba5` |
| `hon-assets/original/school-ai/chibi/jordan.webp` | Jordan | Chibi approved school AI portrait | WebP | 1920 × 1920 | `1a2fe6d0b77a828469be9c1f321ad8c6b2c4ed9a6c6c1bc63e85154d5ec155ec` |
| `hon-assets/original/school-ai/chibi/lena.webp` | Lena | Chibi approved school AI portrait | WebP | 1920 × 1920 | `b9448b48e505a53b8bf1f67997d75cab4b1df6029370a790da4d003c5f014752` |
| `hon-assets/original/school-ai/chibi/marcus.webp` | Marcus | Chibi approved school AI portrait | WebP | 1920 × 1920 | `e98b76ed3b59b4eb471edecdedb29d8ebd4f641fcd59ef73742f43e6419e3ead` |
| `hon-assets/original/school-ai/chibi/maya.webp` | Maya | Chibi approved school AI portrait | WebP | 1920 × 1920 | `b962c5e1844ae02f996142e5769db535ccaeeae9432dc99f79cb5cb0eed1ada6` |
| `hon-assets/original/school-ai/realistic/alex.webp` | Alex | 3D Realistic approved school AI portrait | WebP | 1920 × 1920 | `7bd74431daae53daffd923b8497db553980ac7270a22dbff4d6abc32b05b9503` |
| `hon-assets/original/school-ai/realistic/chad.webp` | Chad | 3D Realistic approved school AI portrait | WebP | 1920 × 1920 | `8a450487f331149761afe5fdcd8910acfe92898b5e78ae60675ffdd9609b3cff` |
| `hon-assets/original/school-ai/realistic/claire.webp` | Claire | 3D Realistic approved school AI portrait | WebP | 1920 × 1920 | `9ad306b24f3a650d81fe74abdad5a5e675b9d054759f5b85348c556831f72a0f` |
| `hon-assets/original/school-ai/realistic/jordan.webp` | Jordan | 3D Realistic approved school AI portrait | WebP | 1920 × 1920 | `5727c93bf9ed97c2ce8c03cd16ba84c113fa12da0eb78dc3049889c611b339ba` |
| `hon-assets/original/school-ai/realistic/lena.webp` | Lena | 3D Realistic approved school AI portrait | WebP | 1920 × 1920 | `82ee666ee767a96116a44903c376b4007c4b01af75cbd7e0c7431d7c0a8cff6c` |
| `hon-assets/original/school-ai/realistic/marcus.webp` | Marcus | 3D Realistic approved school AI portrait | WebP | 1920 × 1920 | `478ab1007cb5ad83394563f3ac3f080b13132476553848d11b8e4ea8293f71b2` |
| `hon-assets/original/school-ai/realistic/maya.webp` | Maya | 3D Realistic approved school AI portrait | WebP | 1920 × 1920 | `82f2685301f855d7766a53c70f6819a2d4d4c2dd844c2b467bd36947033df9f2` |

## Existing original files already in GitHub

| Existing path | Identity | Format | Dimensions | SHA-256 |
| --- | --- | --- | ---: | --- |
| `apps/web/public/ai/alex.webp` | Alex | WebP | 208 × 262 | `be309a1a578f8a3d3b8a706cfb05f9bcb0fa5c53e096945a5cfdf00122a9b2ac` |
| `apps/web/public/ai/chad.webp` | Chad | WebP | 208 × 262 | `384db6992ec152f6b88535fd4c7fb48f18bd92ee98e4bea26a47078bb489331a` |
| `apps/web/public/ai/claire.webp` | Claire | WebP | 208 × 262 | `e0dc95442fe15d67a957549f039cff3169b7b6faed4c0406f19e5b53cb8f9d1a` |
| `apps/web/public/ai/eian.webp` | Eian | WebP | 205 × 305 | `fb3f265f9c7a806a57fdd1bfebbcaa9aec043e57521a789d175d231d51eb382c` |
| `apps/web/public/ai/jordan.webp` | Jordan | WebP | 208 × 262 | `c067f8ae7158768dcb501093fa3003359f19239424ee08b1ff35a79df2b162d6` |
| `apps/web/public/ai/lena.webp` | Lena | WebP | 180 × 262 | `bf7c6ab63f728c363efea099851dd80575b065e4768489273e63174b1dafcdf3` |
| `apps/web/public/ai/marcus.webp` | Marcus | WebP | 208 × 262 | `b7a355d57b47e91212de41385704b0ed431f76f83f2d64f5bc0cefc66ae19822` |
| `apps/web/public/ai/maya.webp` | Maya | WebP | 208 × 262 | `58316e05860c470495f770bd02a7eab147af2b6cbf821538fd480d8db0b98bd4` |

## Missing or blocked original sources

| Intended path | Character / concept | Style | Exact blocker |
| --- | --- | --- | --- |
| `hon-assets/original/school-ai/anime/claire.webp` | Claire | Modern Anime approved school AI portrait | The Manus-hosted path currently serves a 498-byte SVG stating “Image generation failed,” not original artwork. No replacement was created. |
| `hon-assets/original/school-ai/anime/jordan.webp` | Jordan | Modern Anime approved school AI portrait | The Manus-hosted path currently serves a 498-byte SVG stating “Image generation failed,” not original artwork. No replacement was created. |
| `hon-assets/original/school-ai/anime/lena.webp` | Lena | Modern Anime approved school AI portrait | The Manus-hosted path currently serves a 498-byte SVG stating “Image generation failed,” not original artwork. No replacement was created. |
| `hon-assets/original/school-ai/anime/marcus.webp` | Marcus | Modern Anime approved school AI portrait | The Manus-hosted path currently serves a 498-byte SVG stating “Image generation failed,” not original artwork. No replacement was created. |
| — | Chase, Mia, Ethan, Olivia, Ryan, Sophia | HQ executive portraits | No standalone original portrait source was found in GitHub or the current Manus-hosted reference mapping. Exported HQ concept frames are not portraits. |

## Restrictions

- Preserve approved originals exactly. Do not regenerate, resize, recolor, overwrite, remap, or delete them during visual experiments.
- Keep experiments in the Claude-designated experimental folders and use the [Visual Collaboration Protocol](../../../../../docs/architecture/VISUAL_COLLABORATION_PROTOCOL.md).
- These assets are HON project assets. The repository contains no third-party redistribution license. Obtain owner/legal review before external distribution or a public asset-license claim.
- Portrait style is presentation-only: it cannot change employee identity, model route, tools, history, data access, cost, authority, or Action Engine behavior.
- HQ concept frames are review assets, not individual executive portraits or evidence of live HQ work/metrics.

## Machine-readable manifest

See [`MANIFEST.json`](MANIFEST.json) for source locations, byte counts, dimensions, SHA-256 hashes, static web paths, missing sources, and existing GitHub originals.
