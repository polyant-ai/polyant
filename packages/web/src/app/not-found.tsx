// SPDX-License-Identifier: AGPL-3.0-or-later

import AdminNotFound from "./(admin)/not-found";

/**
 * The 404 for an address no route matches. `(admin)/not-found.tsx` only answers a
 * `notFound()` raised inside the admin group; a URL with no page at all fell through
 * to Next's built-in English page, in a panel that is otherwise bilingual and with no
 * way back. Same page, so the two cases look and read alike.
 */
export default AdminNotFound;
