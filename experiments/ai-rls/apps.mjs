export const promptFor = (app) => `Generate the Supabase Postgres schema with RLS policies for: ${app.description}. Users sign in with Supabase Auth.`

export const APPS = [
  { dir: 'tasks', schema: 'app_tasks', description: "team task manager (users belong to teams, see only their team's tasks)", ownerColumns: {} },
  { dir: 'notes', schema: 'app_notes', description: 'personal notes app', ownerColumns: {} },
  {
    dir: 'clinic',
    schema: 'app_clinic',
    description: 'clinic appointments (patients and doctors)',
    ownerColumns: { patients: 'id', doctors: 'id', appointments: 'patient_id', appointment_notes: 'doctor_id' },
  },
  {
    dir: 'marketplace',
    schema: 'app_marketplace',
    description: 'marketplace with buyers, sellers and orders',
    ownerColumns: { orders: 'buyer_id' },
  },
  { dir: 'chat', schema: 'app_chat', description: 'chat app with private conversations', ownerColumns: { messages: 'sender_id' } },
]
