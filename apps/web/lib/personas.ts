import data from '../data/personas.json'

export interface TableWords {
  readonly noun: string
  /** What a stranger is after, when it isn't how a colleague would name it. */
  readonly strangerNoun?: string
  readonly strangerReadNoun?: string
}

/** Who the attackers are, in words a judge who doesn't know RLS can follow. */
export interface Persona {
  /** Starts a sentence: "A stranger (not logged in) can read..." */
  readonly anon: string
  /** A matrix header and a replay actor: "Stranger". */
  readonly anonShort: string
  /** Starts a sentence: "Any logged-in doctor can read..." */
  readonly loggedIn: string
  readonly userA: string
  /** A matrix header: "Dr. Ana, her own rows". */
  readonly userAOwn: string
  /** "other doctors" */
  readonly others: string
  readonly tables: Readonly<Record<string, TableWords>>
}

export const GENERIC_PERSONA: Persona = {
  anon: 'Anyone with the public key',
  anonShort: 'Anon',
  loggedIn: 'Any signed-in user',
  userA: 'User A',
  userAOwn: 'User A, own rows',
  others: 'other users',
  tables: {},
}

const PERSONAS = data as unknown as Readonly<Record<string, Persona>>

export const personaFor = (project: string): Persona => PERSONAS[project] ?? GENERIC_PERSONA

/** "other doctors'" or "the team's". */
export const possessive = (noun: string): string => (noun.endsWith('s') ? `${noun}'` : `${noun}'s`)
