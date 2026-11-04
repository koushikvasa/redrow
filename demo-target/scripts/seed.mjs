// Fills CareNote with obviously fake data. Safe to rerun: it replaces the previous seed.
// Uses the auth admin API, as supabase-js's auth.admin.createUser does, so no extra dependency.
import { randomBytes } from 'node:crypto'
import { connectToDemoDb, demoSupabaseUrl, main, requireEnv } from './db.mjs'

const CLINICIANS = ['dr.ana', 'dr.ben', 'dr.cho']
const EMAIL_DOMAIN = '@carenote.test'
const PATIENTS_PER_CLINICIAN = 40
const NOTES_PER_PATIENT = 3
const USERS_PER_PAGE = 200

async function authAdmin(path, init = {}) {
  const key = requireEnv('DEMO_SERVICE_ROLE_KEY')
  const response = await fetch(`${demoSupabaseUrl().origin}/auth/v1/admin/${path}`, {
    ...init,
    // A redirect could carry the service key to another host.
    redirect: 'error',
    headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
  })
  if (!response.ok) throw new Error(`Auth admin API: ${path} returned HTTP ${response.status}`)
  return response.status === 204 ? null : response.json()
}

/** Only ever matches the test domain, so it can't select anyone real. */
async function findOldClinicians(page = 1) {
  const { users } = await authAdmin(`users?page=${page}&per_page=${USERS_PER_PAGE}`)
  const matches = users.filter((user) => user.email?.endsWith(EMAIL_DOMAIN))
  return users.length < USERS_PER_PAGE ? matches : [...matches, ...(await findOldClinicians(page + 1))]
}

async function createClinician(name) {
  const user = await authAdmin('users', {
    method: 'POST',
    body: JSON.stringify({
      email: `${name}${EMAIL_DOMAIN}`,
      // Nobody signs in as these users: the scan impersonates them.
      password: randomBytes(24).toString('base64url'),
      email_confirm: true,
    }),
  })
  return { id: user.id, name, email: user.email }
}

async function clearRows(sql) {
  // Patients reference auth.users without a cascade, so they have to go before the users do.
  await sql.unsafe(`
    delete from public.invoices;
    delete from public.appointments;
    delete from public.visit_notes;
    delete from public.patients;
    delete from public.profiles;
  `)
}

async function insertRows(sql, clinicians) {
  for (const [index, clinician] of clinicians.entries()) {
    await sql`insert into public.profiles (id, full_name, email)
              values (${clinician.id}, ${`Test Clinician ${clinician.name}`}, ${clinician.email})`
    await sql`
      insert into public.patients (clinician_id, full_name, dob, phone)
      select ${clinician.id}::uuid,
             'Test Patient ' || lpad((${index * PATIENTS_PER_CLINICIAN}::int + g)::text, 3, '0'),
             date '1970-01-01' + (g * 97),
             '555-01' || lpad(g::text, 2, '0')
      from generate_series(1, ${PATIENTS_PER_CLINICIAN}::int) g`
  }
  await sql`
    insert into public.visit_notes (patient_id, author_id, diagnosis, note)
    select p.id, p.clinician_id, 'Fake diagnosis ' || g, 'Fake visit note ' || g
    from public.patients p, generate_series(1, ${NOTES_PER_PATIENT}::int) g`
  await sql`
    insert into public.appointments (patient_id, clinician_id, starts_at)
    select p.id, p.clinician_id, now() + interval '7 days' from public.patients p`
  await sql`
    insert into public.invoices (patient_id, owner_id, amount)
    select p.id, p.clinician_id, 120.00 from public.patients p`
}

await main(async () => {
  const sql = await connectToDemoDb()
  try {
    // Listed first, so a failure here happens before anything has been deleted.
    const old = await findOldClinicians()
    await clearRows(sql)
    for (const user of old) await authAdmin(`users/${user.id}`, { method: 'DELETE' })
    const clinicians = []
    for (const name of CLINICIANS) clinicians.push(await createClinician(name))
    await insertRows(sql, clinicians)
    const [counts] = await sql`
      select (select count(*)::int from public.profiles) as profiles,
             (select count(*)::int from public.patients) as patients,
             (select count(*)::int from public.visit_notes) as visit_notes,
             (select count(*)::int from public.appointments) as appointments,
             (select count(*)::int from public.invoices) as invoices`
    process.stdout.write(`Replaced ${old.length} old users. Seeded: ${JSON.stringify(counts)}\n`)
  } finally {
    await sql.end({ timeout: 5 })
  }
})
