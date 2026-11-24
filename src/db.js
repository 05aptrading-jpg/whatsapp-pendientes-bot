import { createClient } from '@supabase/supabase-js';
import { logger } from './config.js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
  global: { retryCount: 2, retryDelay: 1500 },
});

export { supabase, logger };
