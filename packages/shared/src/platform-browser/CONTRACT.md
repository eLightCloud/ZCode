# Browser platform wire contract

The existing platform facade re-exports these browser ownership, residency, permission and data-import wire types. Main remains the authority for sender, tab generation and OS permission. Moving declarations here does not change fields, constants, URL encoding, browser execution or authorization. View ownership and permission/data operations have separate internal declarations; consumers keep the existing @zcode/shared facade.
