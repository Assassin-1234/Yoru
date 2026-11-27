// Standalone stream service for production: nginx proxies /zoko/ here.
// Run with `npm run start:streams`; nothing here is public except /zoko/*.
import { createZokoServer } from './zoko.mjs';
import { prewarmAnizone } from './anizone.mjs';

createZokoServer(Number(process.env.PORT) || 5174);
prewarmAnizone().catch(() => {});
