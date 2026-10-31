import * as dotenv from 'dotenv';

// Must be imported first in server entrypoints so .env variables are populated
// before any downstream ES module evaluates configuration.
dotenv.config();
