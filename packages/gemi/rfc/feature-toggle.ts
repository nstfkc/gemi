class Features {
  enabled = false;
  static enable(key: string, options: any) {}
}

class FeaturesServiceProvider {}

Features.enable("foo", {
  lottery: 50,
});

function useFeature() {
  return {
    enabled: false,
  };
}
