export enum InstructionType {
    CALL,
    RET,
    RST,
    INT,
    OTHER,
}

/**
 * Work out what kind of instruction was just executed, from the first
 * bytes that were fetched and how the stack pointer changed. Conditional
 * CALLs and RETs only count if they were taken.
 */
export function classifyInstruction(
    fetched: number[],
    spBefore: number,
    spAfter: number
): InstructionType {
    let opcode = fetched[0];
    let next: number | undefined = fetched[1];
    if ((opcode === 0xdd || opcode === 0xfd) && next !== undefined) {
        // IX and IY prefixes are ignored by instructions which don't use
        // HL, so e.g. DD C9 is still a RET
        opcode = next;
        next = undefined;
    }
    const pushed = spAfter === ((spBefore - 2) & 0xffff);
    const popped = spAfter === ((spBefore + 2) & 0xffff);
    if (opcode === 0xcd || (opcode & 0xc7) === 0xc4) {
        return pushed ? InstructionType.CALL : InstructionType.OTHER;
    }
    if ((opcode & 0xc7) === 0xc7) {
        return InstructionType.RST;
    }
    if (opcode === 0xc9 || (opcode & 0xc7) === 0xc0) {
        return popped ? InstructionType.RET : InstructionType.OTHER;
    }
    if (opcode === 0xed && next !== undefined && (next & 0xc7) === 0x45) {
        // RETN, RETI and their undocumented mirrors
        return InstructionType.RET;
    }
    return InstructionType.OTHER;
}
