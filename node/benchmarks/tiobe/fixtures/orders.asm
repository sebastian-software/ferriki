; NASM x86-64, Linux system calls. Sum completed integer-cent records.
bits 64
default rel
%define SYS_WRITE 1
%define SYS_EXIT 60
%define RECORD_SIZE 16

section .rodata
    label: db "<total> completed orders </total>", 10
    label_len: equ $ - label
    orders: dq 1995, 1, 1250, 1, 500, 0
    order_count: equ ($ - orders) / RECORD_SIZE

section .bss
    total: resq 1

section .text
global _start
_start:
    xor r8, r8
    lea rsi, [orders]
    mov ecx, order_count
.next:
    cmp qword [rsi + 8], 0
    je .skip
    add r8, [rsi]
.skip:
    add rsi, RECORD_SIZE
    loop .next
    mov [total], r8
    mov eax, SYS_WRITE
    mov edi, 1
    lea rsi, [label]
    mov edx, label_len
    syscall
    mov eax, SYS_EXIT
    xor edi, edi
    syscall
