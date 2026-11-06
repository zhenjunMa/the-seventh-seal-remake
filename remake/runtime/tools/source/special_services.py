"""Reward closure of GAME.exe's recovered TLK mutation18 handlers.

The tables are static native rules, never player grants or configurable loot.
41A640/4DB570 selects seven statue rewards; 4E0890..4E0EED maps the 25
six-digit casino codes to 24 items. The immutable executable identity is
checked by both callers before admitting these acquisition sources.
"""
import hashlib

GAME_SHA = 'fc6c01945d4898a221e40be72c32158371205896c096622727fa23f7ee794d18'
STATUE_REWARDS = (139, 142, 124, 134, 138, 141, 143)
LOTTO_REWARDS = (205, 175, 177, 178, 179, 180, 187, 182, 181, 183,
                 184, 185, 186, 188, 189, 190, 200, 201, 203, 204,
                 174, 206, 207, 208, 209)
CASINO_CODES = {
    '651111': 205, '132456': 175, '745621': 177, '632411': 178,
    '734206': 179, '753642': 180, '179584': 187, '403785': 182,
    '324325': 181, '501429': 183, '399281': 184, '225698': 185,
    '407635': 186, '432441': 188, '775236': 189, '863221': 190,
    '206241': 200, '523201': 201, '809654': 203, '661124': 204,
    '298445': 205, '100236': 206, '660528': 207, '457965': 208,
    '600404': 209,
}


def reward_ids(record, executable):
    if record['mutation_type'] != 18:
        return ()
    if hashlib.sha256(executable).hexdigest() != GAME_SHA:
        raise ValueError('Special-service native executable identity changed')
    mode, index = record['mutation_index'], record['mutation_bit']
    if mode == 2:
        if not 1 <= index <= 7:
            raise ValueError('Invalid native statue index')
        return (STATUE_REWARDS[index - 1],)
    if mode == 5 and index == 0:
        return tuple(sorted(set(CASINO_CODES.values())))
    if mode == 0 and index == 0:
        return LOTTO_REWARDS
    if mode in (3, 4) and index == 0:
        return ()
    raise ValueError('Unsupported native special service')
