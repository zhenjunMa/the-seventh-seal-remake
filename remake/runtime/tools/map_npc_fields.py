"""Source NPC fields after the original map-loader initialization."""

NPC_VISIBILITY_EVIDENCE = "ev_cc8392615a7d78e2d6d4cc2dbfbc632ed4e69ade06250acba27d0a0c5a951b2b"


def initial_npc_visibility(raw):
    if len(raw) != 0x4C5:
        raise ValueError("A map NPC record must contain exactly 0x4C5 source bytes")
    # 0x4B4F10 applies +2AC after DAT loading, before exploration starts.
    # This initializes +97; it is not a permanent gate against ANM reveal.
    return dict(hidden=bool(raw[0x97] or raw[0x2AC]),
                hidden_raw_97=raw[0x97], hidden_on_load_raw_2ac=raw[0x2AC],
                initial_visibility_evidence=[NPC_VISIBILITY_EVIDENCE])
