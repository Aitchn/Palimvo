# JSON tree viewer

Opens `.json` files as a tree you can fold. The first two levels start open, the search box keeps
only the branches whose keys or values match, and a file that changes on disk is redrawn.
Objects and arrays with more than 500 entries show the first 500 and a count. Invalid JSON shows
the parser's message. The plain text stays one click away in the file's viewer switch.

It is read-only and asks only for `read`.
