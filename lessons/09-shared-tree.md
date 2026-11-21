# Working in a shared tree

Several agents edit one checkout. Publishing from a dirty tree is refused by design (a release is built from a commit, never a working tree), and the tree is usually dirty with someone else's work.

- Commit only your own paths (`git commit -m ... -- <pathspec>`); never `git add -A` or restore a path from another revision into the shared index.
- Publish scratch builds while the tree is dirty; a scratch build is the same URL form.
- Mirror to a remote by splitting the subdirectory's committed history, never the working tree, so another agent's half-finished edit never ships. When a private history is mirrored, publish a separate scrubbed single-commit tree for anything public.
- Remove probe artifacts and throwaway app directories when done.

Fed: R15, P24, P26.
