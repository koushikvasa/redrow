import { describe, expect, it } from 'vitest'
import { chooseActors } from '../src/actors'

const A = '00000000-0000-4000-8000-00000000000a'
const B = '00000000-0000-4000-8000-00000000000b'
const C = '00000000-0000-4000-8000-00000000000c'

describe('chooseActors', () => {
  it('prefers the owner who appears in the most tables, then the most rows', () => {
    const owners = [
      [{ owner: A, n: 100 }],
      [
        { owner: B, n: 5 },
        { owner: C, n: 4 },
      ],
      [{ owner: B, n: 5 }],
    ]
    expect(chooseActors(owners)).toEqual({ userA: B, userB: A })
  })

  it('uses row count to break a tie on table count', () => {
    const owners = [
      [
        { owner: A, n: 1 },
        { owner: B, n: 9 },
      ],
    ]
    expect(chooseActors(owners)).toEqual({ userA: B, userB: A })
  })

  it('leaves userB unset when only one owner exists, so a random id gets generated', () => {
    expect(chooseActors([[{ owner: A, n: 3 }]])).toEqual({ userA: A })
  })

  it('leaves both unset when no table has owners', () => {
    expect(chooseActors([[], []])).toEqual({})
  })

  it('ignores owner values that are not uuids, since auth.uid() would fail on them', () => {
    const owners = [
      [
        { owner: 'not-a-uuid', n: 50 },
        { owner: A, n: 1 },
      ],
    ]
    expect(chooseActors(owners)).toEqual({ userA: A })
  })
})
