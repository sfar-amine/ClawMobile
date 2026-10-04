# Bank UI trace runtime — 2026-10-04

Companion accepts a bounded bank-ui-event only on the native loopback payment boundary. It supports bank navigation, return detection/request/response and result presentation. Navigation is restricted to reviewed HTTPS origins and query-free normalized paths. The event is appended to the existing PaymentRecord timeline and never changes financial state.
