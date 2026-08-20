!macro NSIS_HOOK_POSTUNINSTALL
  ; Session keys and refresh credentials live only in this per-user directory.
  ; Removing it on uninstall cryptographically erases every recoverable capture.
  RMDir /r "$APPDATA\com.knowhow.capture"
  RMDir /r "$LOCALAPPDATA\com.knowhow.capture"
!macroend
