!macro NSIS_HOOK_POSTINSTALL
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\.opus\UserChoice"
  ReadRegStr $0 SHELL_CONTEXT "Software\Classes\.opus" ""
  WriteRegStr SHELL_CONTEXT "Software\Classes\.opus" "Content Type" "application/x-opus-project"
  WriteRegStr SHELL_CONTEXT "Software\Classes\.opus" "PerceivedType" "document"
  WriteRegStr SHELL_CONTEXT "Software\Classes\.opus\DefaultIcon" "" "$\"$INSTDIR\resources\opus-project.ico$\",0"
  ${If} $0 != ""
    WriteRegStr SHELL_CONTEXT "Software\Classes\$0" "FriendlyTypeName" "OPUS project file"
    WriteRegStr SHELL_CONTEXT "Software\Classes\$0\DefaultIcon" "" "$\"$INSTDIR\resources\opus-project.ico$\",0"
  ${EndIf}
  !insertmacro UPDATEFILEASSOC
!macroend
