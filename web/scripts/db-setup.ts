#!/usr/bin/env node

/**
 * Database setup script for Supabase
 * This script initializes the database schema and optionally seeds data
 */

import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'fs';
import { join } from 'path';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config({ path: '.env.local' });

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('❌ Missing required environment variables:');
  console.error('   NEXT_PUBLIC_SUPABASE_URL');
  console.error('   SUPABASE_SERVICE_ROLE_KEY');
  console.error('\nPlease set these in your .env.local file');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: {
    autoRefreshToken: false,
    persistSession: false
  }
});

async function runMigration(sqlFile: string): Promise<void> {
  const sql = readFileSync(sqlFile, 'utf8');
  
  console.log(`📝 Running migration: ${sqlFile}`);
  
  const { error } = await supabase.rpc('exec_sql', { sql_query: sql });
  
  if (error) {
    console.error(`❌ Migration failed: ${error.message}`);
    throw error;
  }
  
  console.log(`✅ Migration completed: ${sqlFile}`);
}

async function seedDatabase(): Promise<void> {
  const seedFile = join(process.cwd(), 'supabase', 'seed', 'seed.sql');
  const sql = readFileSync(seedFile, 'utf8');
  
  console.log('🌱 Seeding database...');
  
  // Split SQL into individual statements (simple split on semicolon)
  const statements = sql
    .split(';')
    .map(s => s.trim())
    .filter(s => s.length > 0);
  
  for (const statement of statements) {
    if (statement.toLowerCase().startsWith('insert')) {
      // For INSERT statements, we can use the Supabase client directly
      console.log('   Executing: ', statement.substring(0, 50) + '...');
      
      const { error } = await supabase.rpc('exec_sql', { 
        sql_query: statement + ';' 
      });
      
      if (error) {
        console.error(`   ❌ Failed: ${error.message}`);
      } else {
        console.log('   ✅ Success');
      }
    }
  }
  
  console.log('🌱 Seeding completed');
}

async function checkConnection(): Promise<boolean> {
  try {
    const { data, error } = await supabase
      .from('shorts')
      .select('count')
      .limit(1);
    
    if (error && error.code !== 'PGRST116') { // PGRST116 = table doesn't exist
      console.error('❌ Database connection failed:', error.message);
      return false;
    }
    
    console.log('✅ Database connection successful');
    return true;
  } catch (err) {
    console.error('❌ Database connection failed:', err);
    return false;
  }
}

async function main() {
  console.log('🚀 Supabase Database Setup');
  console.log('==========================\n');
  
  // Check connection
  const connected = await checkConnection();
  if (!connected) {
    process.exit(1);
  }
  
  // Run migrations
  try {
    const migrationFile = join(
      process.cwd(), 
      'supabase', 
      'migrations', 
      '20250107_001_initial_schema.sql'
    );
    
    await runMigration(migrationFile);
  } catch (error) {
    console.error('❌ Migration failed:', error);
    process.exit(1);
  }
  
  // Optionally seed database
  if (process.argv.includes('--seed')) {
    try {
      await seedDatabase();
    } catch (error) {
      console.error('❌ Seeding failed:', error);
      process.exit(1);
    }
  }
  
  console.log('\n✅ Database setup completed successfully!');
  
  // Show some stats
  const { count: shortsCount } = await supabase
    .from('shorts')
    .select('*', { count: 'exact', head: true });
  
  const { count: companiesCount } = await supabase
    .from('company-metadata')
    .select('*', { count: 'exact', head: true });
  
  const { count: pricesCount } = await supabase
    .from('stock_prices')
    .select('*', { count: 'exact', head: true });
  
  console.log('\n📊 Database Statistics:');
  console.log(`   Short positions: ${shortsCount || 0} records`);
  console.log(`   Companies: ${companiesCount || 0} records`);
  console.log(`   Stock prices: ${pricesCount || 0} records`);
}

// Run the script
main().catch(console.error);