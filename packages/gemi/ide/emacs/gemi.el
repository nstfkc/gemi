(defun gemi/project-root ()
  "Find the project root directory."
  (let* ((default-directory (or (buffer-file-name) default-directory))
         (root-markers '(".git" ".project" ".projectile" "Makefile" "package.json" ".gemi")))
    (locate-dominating-file default-directory
                            (lambda (dir)
                              (seq-some
                               (lambda (marker)
                                 (file-exists-p (expand-file-name marker dir)))
                               root-markers)))))

(defun gemi/ide (root)
  (condition-case err
      (let* ((default-directory root)
             (json-output (shell-command-to-string "gemi ide:generate-api-manifest"))
             (json-data (json-read-from-string json-output)))
        json-data)
    (error
     (progn
       (message "Error parsing JSON: %s" (error-message-string err))
       nil))))

(defun gemi/discover-api-route-handlers ()
  "Discover gemi API route handlers."
  (interactive)

  (let* ((project-root (gemi/project-root))
         (json-data (gemi/ide project-root))
         (first-level-keys (mapcar #'symbol-name (map-keys json-data)))
         (first-choice (completing-read "Select a route " first-level-keys nil t))
         (first-level-value (cdr (assoc (intern first-choice) json-data)))
         (second-level-keys (mapcar #'symbol-name (map-keys first-level-value)))
         (second-choice (if (= (length second-level-keys) 1)
                            (car second-level-keys)
                          (completing-read "Select a method: " second-level-keys nil t)))
         (file-info (cdr (assoc (intern second-choice) first-level-value))))
    (let ((file-path (cdr (assoc 'file file-info)))
          (line (cdr (assoc 'line file-info)))
          (column (cdr (assoc 'column file-info))))
      (find-file (concat project-root file-path))
      (goto-line line)
      (move-to-column column)
      (recenter))))
