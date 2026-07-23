import { defineFilesystemConfig, S3Driver } from "gemi/services";

export default defineFilesystemConfig({
  driver: new S3Driver(),
});
