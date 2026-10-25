# Development stand-in for our Mealie instance

`fake-mealie/` serves sample data in the shapes our Mealie instance's API uses:

    node dev/fake-mealie/server.js dev/fake-mealie/sample.json        # prints its URL
    MEALIE_URL=<that URL> npm start

It serves `GET /api/recipes?page=&perPage=`, `GET /api/recipes/{slug}` and `GET /api/foods?page=&perPage=`.
Like the real instance, it may return fewer items per page than requested.
