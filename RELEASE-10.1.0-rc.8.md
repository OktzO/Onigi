# onigis 10.1.0-rc.8

Fixes a group-encryption outage introduced in rc.7. **If you are running rc.7 or
earlier, upgrade — every incoming group message is being dropped.**

## The symptom

    FAIL library error: failed to decrypt message | No session found to decrypt message
    FAIL library error: transaction failed, rolling back

The message names sessions. The missing thing is a *sender key*.

## Why

Two changes in rc.7 combine into a silent failure.

`SenderKeyName.serialize()` was corrected to key on the sender's name. It had
been reading `this.sender.id`, and oktz-signal's `ProtocolAddress` defines no
`id` — so every sender serialized as `<group>::undefined::<device>` and all
members of a group shared one store slot. That was a real defect, and the
correction is correct.

But it also moved every existing sender key. State written before the rename
lives under the old name and is unreachable under the new one.

The rename then failed quietly, because `loadSenderKey` answers a miss with an
empty `SenderKeyRecord` rather than `null`. `GroupCipher`'s own
`if (!record)` guard is therefore unreachable, and the miss surfaces one line
later as `No session found to decrypt message`.

## The fix

On a miss, `loadSenderKey` looks once under the name the old format produced.

- **Read-only.** `storeSenderKey` still writes the current name, so a record
  recovered this way is re-saved correctly on the next write and the legacy
  slot stops being consulted for that sender.
- **The legacy slot is only read when the current name misses.** A record
  under the current name always wins, so nothing already correct gets
  shadowed by the old shared slot.
- **The collision fix is unaffected.** New keys are still stored per sender.

No session rescan and no re-pairing is needed. The first successful decrypt
after upgrading migrates the record.

## Verification

The regression is reproduced end to end through `decryptGroupMessage`, the
entry point production calls: a sender repository encrypts, the recipient's
copy of the sender key is moved to the name the previous release wrote, and
decryption is attempted. Before the fix that throws the production error
verbatim. Five tests cover the legacy name, per-device matching, the
current-name-wins ordering, and that a sender with no key still reports a
missing key rather than being handed a fabricated one.

Suite: 433 pass / 0 fail (was 428; +5 for this fix).
