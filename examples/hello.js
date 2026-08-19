



globalThis.getHome = (cb) => {
  cb({
    success: true,
    data: {
      Hello: [
        new MultimediaItem({
          title: "Hello World",
          url: "https://example.com/movie",
          type: "movie",
        }),
      ],
    },
  });
};
